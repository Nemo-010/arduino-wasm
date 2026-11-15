#!/usr/bin/env python3
"""Build a local arduino:avr package index and its archives.

The official index is served from downloads.arduino.cc, which answers 403 to
this sandbox for every user agent, so nothing here can install arduino:avr from
it. A page in somebody's browser has no such problem, so the test uses a fixture
with the same shape instead of teaching the product about a special case.

What is real and what is not:

  * the AVR core is the upstream ArduinoCore-avr source tree at the tag, with
    its wrapper directory stripped so the archive unpacks like the official one;
  * the tool packages (avr-gcc, avrdude, arduinoOTA, ctags) are stand-ins. Their
    binaries are never executed: the page runs its own wasm toolchain through
    the exec hook, and ctags is answered in JavaScript;
  * every checksum is the SHA-256 of the bytes actually written, so the CLI's
    verification still has to pass.

    python3 test/fixtures-avr.py [--core 1.8.6]
"""

import argparse
import hashlib
import io
import json
import os
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, "build")
OUT = os.path.join(BUILD, "fixtures-avr")

CORE_TAG = "1.8.6"
CORE_URL = "https://codeload.github.com/arduino/ArduinoCore-avr/tar.gz/refs/tags/" + CORE_TAG

HOST = "x86_64-pc-linux-gnu"
BASE_URL = "http://fixture.invalid/"

# The versions the real index uses for arduino:avr 1.8.6, so the properties the
# core's platform.txt expands contain the same paths a desktop build produces.
TOOLS = [
    ("avr-gcc", "7.3.0-atmel3.6.1-arduino7", ["bin/avr-gcc", "bin/avr-g++", "bin/avr-ar", "bin/avr-objcopy", "bin/avr-size", "bin/avr-nm", "bin/avr-objdump"]),
    ("avrdude", "6.3.0-arduino17", ["bin/avrdude", "bin/avrdude.conf"]),
    ("arduinoOTA", "1.3.0", ["bin/arduinoOTA"]),
]
BUILTIN_TOOLS = [
    ("ctags", "5.8-arduino11", ["ctags"]),
]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def log(message):
    print(message, flush=True)


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        log("cached " + os.path.basename(path))
        return path
    log("fetching " + url)
    request = urllib.request.Request(url, headers={"User-Agent": "arduino-wasm-fixture"})
    with urllib.request.urlopen(request, timeout=180) as response, open(path, "wb") as handle:
        while True:
            block = response.read(1 << 20)
            if not block:
                break
            handle.write(block)
    return path


def repack_core(source, target, wrapper):
    """Rewrite the GitHub tarball under a single wrapper directory.

    The installer refuses an archive without exactly one top-level directory,
    and the GitHub archive's directory is named after the repository rather than
    the platform version. Renaming it keeps the fixture the shape the installer
    accepts without teaching it anything new.
    """
    with tarfile.open(source, "r:gz") as src, tarfile.open(target, "w:bz2") as dst:
        names = src.getnames()
        prefix = names[0].split("/")[0] + "/"
        for member in src:
            if not member.name.startswith(prefix):
                continue
            member.name = wrapper + member.name[len(prefix):]
            if not member.name:
                continue
            if member.isfile():
                member.size = member.size
                handle = src.extractfile(member)
                data = handle.read() if handle else b""
                member = tarfile.TarInfo(member.name)
                member.size = len(data)
                member.mode = 0o644
                member.mtime = 0
                dst.addfile(member, io.BytesIO(data))
            elif member.isdir():
                member = tarfile.TarInfo(member.name)
                member.type = tarfile.DIRTYPE
                member.mode = 0o755
                member.mtime = 0
                dst.addfile(member)
    return target


def write_tool_archive(name, version, files, target):
    """A tool package with the files platform.txt expects to find, no bytes of
    their own. Never executed: the page answers these commands itself.

    The installer insists on a single top-level directory and strips it, which
    is how the official tool archives are built, so the wrapper is part of the
    fixture rather than something the product has to tolerate.
    """
    wrapper = name + "-" + version + "/"
    with tarfile.open(target, "w:gz") as archive:
        for entry in files:
            body = b"stand-in: the page runs this command with its own wasm tools.\n"
            member = tarfile.TarInfo(wrapper + entry)
            member.size = len(body)
            member.mode = 0o755
            member.mtime = 0
            archive.addfile(member, io.BytesIO(body))
    return target


def tool_entry(name, version, path):
    return {
        "name": name,
        "version": version,
        "systems": [{
            "host": HOST,
            "url": BASE_URL + "tools/" + os.path.basename(path),
            "archiveFileName": os.path.basename(path),
            "checksum": "SHA-256:" + sha256(path),
            "size": str(os.path.getsize(path)),
        }],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", default=CORE_TAG)
    args = parser.parse_args()

    os.makedirs(os.path.join(OUT, "tools"), exist_ok=True)
    os.makedirs(BUILD, exist_ok=True)

    source = os.path.join(BUILD, "avr-core-" + args.core + ".tar.gz")
    download(CORE_URL, source)

    core_archive = os.path.join(OUT, "avr-" + args.core + ".tar.bz2")
    log("repacking core from " + os.path.basename(source))
    repack_core(source, core_archive, "avr-" + args.core + "/")

    tool_entries = []
    for name, version, files in TOOLS:
        target = os.path.join(OUT, "tools", name + "-" + version + ".tar.gz")
        write_tool_archive(name, version, files, target)
        tool_entries.append(tool_entry(name, version, target))

    builtin_entries = []
    for name, version, files in BUILTIN_TOOLS:
        target = os.path.join(OUT, "tools", name + "-" + version + ".tar.gz")
        write_tool_archive(name, version, files, target)
        builtin_entries.append(tool_entry(name, version, target))

    dependencies = [{"packager": "arduino", "name": name, "version": version} for name, version, _ in TOOLS]
    dependencies.append({"packager": "builtin", "name": "ctags", "version": "5.8-arduino11"})

    index = {
        "packages": [
            {
                "name": "arduino",
                "maintainer": "Arduino",
                "websiteURL": "https://www.arduino.cc/",
                "email": "packages@arduino.cc",
                "platforms": [{
                    "name": "Arduino AVR Boards",
                    "architecture": "avr",
                    "version": args.core,
                    "category": "Arduino",
                    "help": {"online": "https://www.arduino.cc/en/Reference/HomePage"},
                    "url": BASE_URL + os.path.basename(core_archive),
                    "archiveFileName": os.path.basename(core_archive),
                    "checksum": "SHA-256:" + sha256(core_archive),
                    "size": str(os.path.getsize(core_archive)),
                    "boards": [
                        {"name": "Arduino Uno"},
                        {"name": "Arduino Nano"},
                        {"name": "Arduino Mega or Mega 2560"},
                    ],
                    "toolsDependencies": dependencies,
                }],
                "tools": tool_entries,
            },
            {
                "name": "builtin",
                "maintainer": "Arduino",
                "websiteURL": "https://www.arduino.cc/",
                "email": "packages@arduino.cc",
                "platforms": [],
                "tools": builtin_entries,
            },
        ]
    }

    index_path = os.path.join(OUT, "package_index.json")
    with open(index_path, "w") as handle:
        json.dump(index, handle, indent=2)
        handle.write("\n")

    log("wrote " + index_path)
    log("core archive " + core_archive + " " + str(os.path.getsize(core_archive)) + " bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
