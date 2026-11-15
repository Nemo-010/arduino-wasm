#!/usr/bin/env python3
"""Build a Seeeduino:nrf52 package index and its archives for an origin we control.

This is the nRF52 twin of scripts/make-avr-index.py: the page carries its own
copy of the platform so that a compile needs no network at all, and so that a
sandbox with no route to files.seeedstudio.com can still test the whole path.

What is real and what is not:

  * the platform archive is the vendor tarball, byte for byte, at the version
    the vendor index names. Its checksum and size are the vendor's own;
  * the CMSIS archive carries the real Cortex-M4F DSP library and the real
    CMSIS headers, taken from the CMSIS 5.7.0 archive the vendor index names.
    The linker needs the library and the core includes the headers, so neither
    can be a stand-in;
  * arm-none-eabi-gcc and nrfjprog are stand-ins. Their binaries are never
    executed: web/arm-driver.js answers every tool invocation from the wasm
    toolchain built out of GCC 9.2.0 and binutils 2.42. They exist so the
    installer finds what the index says the platform needs, and nrfjprog is a
    flasher that a page cannot run anyway.

    python3 scripts/make-nrf52-index.py --out web/indexes/nrf52 \\
        --base-url https://arduino-wasm.invalid/indexes/nrf52/
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
CACHE = os.path.join(ROOT, "build", "arm-wasm")

# Not pinned: the vendor index moves when Seeed publishes a release, and the
# archive it names is the thing whose bytes must not change.
VENDOR_INDEX = "https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json"

# The vendor names this platform with these two tools, and its platform.txt
# expands {runtime.tools.CMSIS-5.7.0.path}, so the names and versions are
# load-bearing rather than decorative.
GCC_VERSION = "9-2019q4"
NRFJPROG_VERSION = "9.4.0"
CMSIS_VERSION = "5.7.0"

CMSIS_URL = "https://github.com/stm32duino/ArduinoModule-CMSIS/releases/download/5.7.0/CMSIS-5.7.0.tar.bz2"
# See the comment at index_path: this name must differ from the AVR page's
# package_index.json, because the CLI saves an index under its URL basename.
INDEX_NAME = "nrf52_index.json"

CMSIS_SHA256 = "0b04b0f214e483bcc360cda985cddc0de8031714019ceabcda4770d510b82bfe"
CMSIS_SIZE = 26151901
# Everything platform.txt reaches for, and nothing else: the DSP library is
# 6.4 MB and the rest of that archive is other cores' variants.
CMSIS_MEMBERS = [
    "CMSIS/CMSIS/Core/Include/",
    "CMSIS/CMSIS/DSP/Include/",
    "CMSIS/CMSIS/DSP/Lib/GCC/libarm_cortexM4lf_math.a",
]

HOST = "x86_64-pc-linux-gnu"
PLATFORM_SHA256 = "2c22069bb83f4600d4076c31312b124f946bd4ab4d19ae3c46f3142f8a05e6f3"
PLATFORM_SIZE = 23218120


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def log(message):
    print(message, flush=True)


def download(url, path, expect_sha256=None, expect_size=None):
    if os.path.exists(path) and os.path.getsize(path) == (expect_size or os.path.getsize(path)):
        log("cached " + os.path.basename(path))
    else:
        log("fetching " + url)
        request = urllib.request.Request(url, headers={"User-Agent": "arduino-wasm-index"})
        with urllib.request.urlopen(request, timeout=300) as response, open(path, "wb") as handle:
            while True:
                block = response.read(1 << 20)
                if not block:
                    break
                handle.write(block)
    size = os.path.getsize(path)
    digest = sha256(path)
    if expect_size is not None and size != expect_size:
        raise SystemExit(f"{path}: {size} bytes, expected {expect_size}")
    if expect_sha256 is not None and digest != expect_sha256:
        raise SystemExit(f"{path}: sha256 {digest}, expected {expect_sha256}")
    log(f"verified {os.path.basename(path)} {size} bytes sha256 {digest}")
    return path


def write_stand_in_tool(name, version, files, target):
    """A tool package with the files platform.txt expects to find, with no bytes
    of their own. Never executed: the page answers these commands itself.

    The installer insists on a single top-level directory and strips it, which
    is how the official tool archives are built, so the wrapper is part of the
    archive rather than something the product has to tolerate.
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


def write_cmsis_tool(source, target):
    """The real headers and the real DSP library, under the layout the platform
    expects: <tool>/CMSIS/Core/Include/, <tool>/CMSIS/DSP/Include/ and
    <tool>/CMSIS/DSP/Lib/GCC/libarm_cortexM4lf_math.a.

    The vendor archive has these one level deeper, under its own CMSIS/ root.
    The installer strips the archive's single top-level directory, so the
    wrapper written here replaces that root rather than adding to it.
    """
    wrapper = "CMSIS-" + CMSIS_VERSION + "/"
    written = 0
    with tarfile.open(source, "r:bz2") as src, tarfile.open(target, "w:gz") as dst:
        for member in src:
            path = member.name
            if not any(path == m or path.startswith(m) for m in CMSIS_MEMBERS):
                continue
            name = wrapper + path[len("CMSIS/"):]
            if member.isfile():
                handle = src.extractfile(member)
                data = handle.read() if handle else b""
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o644
                entry.mtime = 0
                dst.addfile(entry, io.BytesIO(data))
                written += 1
            elif member.isdir():
                entry = tarfile.TarInfo(name)
                entry.type = tarfile.DIRTYPE
                entry.mode = 0o755
                entry.mtime = 0
                dst.addfile(entry)
    if written < 30:
        raise SystemExit(f"{target}: only {written} files, the CMSIS archive is not the shape this expects")
    log(f"cmsis subset: {written} files")
    return target


def tool_entry(name, version, path, base_url):
    return {
        "name": name,
        "version": version,
        "systems": [{
            "host": HOST,
            "url": base_url + "tools/" + os.path.basename(path),
            "archiveFileName": os.path.basename(path),
            "checksum": "SHA-256:" + sha256(path),
            "size": str(os.path.getsize(path)),
        }],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", default="1.1.9", help="Seeeduino:nrf52 version to carry")
    parser.add_argument("--out", default=os.path.join(ROOT, "web", "indexes", "nrf52"))
    parser.add_argument("--base-url", default="https://arduino-wasm.invalid/indexes/nrf52/")
    args = parser.parse_args()

    platform_version = args.platform
    if platform_version != "1.1.9":
        raise SystemExit(
            "this script pins the checksum of 1.1.9 only; a new version needs its "
            "archive verified and PLATFORM_SHA256/PLATFORM_SIZE updated"
        )

    out = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
    base_url = args.base_url if args.base_url.endswith("/") else args.base_url + "/"
    os.makedirs(os.path.join(out, "tools"), exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)

    vendor_index_path = os.path.join(CACHE, "seeeduino_index.json")
    download(VENDOR_INDEX, vendor_index_path)
    with open(vendor_index_path) as handle:
        vendor = json.load(handle)

    package = next((p for p in vendor["packages"] if p["name"] == "Seeeduino"), None)
    if package is None:
        raise SystemExit("the vendor index has no Seeeduino package")
    platform = next(
        (p for p in package["platforms"] if p["architecture"] == "nrf52" and p["version"] == platform_version),
        None,
    )
    if platform is None:
        raise SystemExit(f"the vendor index has no nrf52 {platform_version}")

    # The vendor's own metadata is kept: its board list is what the CLI shows a
    # user, and rewriting it here would let this page drift from the platform.
    platform = dict(platform)
    platform_url = platform["url"]
    archive_name = platform["archiveFileName"]
    archive_path = os.path.join(CACHE, archive_name)
    download(platform_url, archive_path, PLATFORM_SHA256, PLATFORM_SIZE)
    shipped = os.path.join(out, archive_name)
    if os.path.abspath(archive_path) != os.path.abspath(shipped):
        with open(archive_path, "rb") as src, open(shipped, "wb") as dst:
            while True:
                block = src.read(1 << 20)
                if not block:
                    break
                dst.write(block)
    platform["url"] = base_url + archive_name
    platform["checksum"] = "SHA-256:" + PLATFORM_SHA256
    platform["size"] = str(PLATFORM_SIZE)

    tools = []
    gcc = write_stand_in_tool(
        "arm-none-eabi-gcc",
        GCC_VERSION,
        ["bin/arm-none-eabi-gcc", "bin/arm-none-eabi-g++", "bin/arm-none-eabi-ar",
         "bin/arm-none-eabi-objcopy", "bin/arm-none-eabi-size", "bin/arm-none-eabi-nm",
         "bin/arm-none-eabi-objdump", "bin/arm-none-eabi-gcc-ar"],
        os.path.join(out, "tools", "arm-none-eabi-gcc-" + GCC_VERSION + ".tar.gz"),
    )
    tools.append(tool_entry("arm-none-eabi-gcc", GCC_VERSION, gcc, base_url))

    nrfjprog = write_stand_in_tool(
        "nrfjprog",
        NRFJPROG_VERSION,
        ["bin/nrfjprog"],
        os.path.join(out, "tools", "nrfjprog-" + NRFJPROG_VERSION + ".tar.gz"),
    )
    tools.append(tool_entry("nrfjprog", NRFJPROG_VERSION, nrfjprog, base_url))

    cmsis_source = download(
        CMSIS_URL,
        os.path.join(CACHE, "cmsis-" + CMSIS_VERSION + ".tar.bz2"),
        CMSIS_SHA256,
        CMSIS_SIZE,
    )
    cmsis = write_cmsis_tool(cmsis_source, os.path.join(out, "tools", "CMSIS-" + CMSIS_VERSION + ".tar.gz"))
    tools.append(tool_entry("CMSIS", CMSIS_VERSION, cmsis, base_url))

    index = {
        "packages": [{
            "name": "Seeeduino",
            "maintainer": package.get("maintainer", "Seeed"),
            "websiteURL": package.get("websiteURL", "https://www.seeedstudio.com/"),
            "email": package.get("email", ""),
            "platforms": [platform],
            "tools": tools,
        }]
    }

    # The file name is not decoration: arduino-cli keys the index files in its
    # data directory by the basename of the URL, so a second index called
    # package_index.json would silently overwrite the AVR one and the platform
    # in it would disappear. INDEX_NAME keeps the two basenames distinct.
    index_path = os.path.join(out, INDEX_NAME)
    with open(index_path, "w") as handle:
        json.dump(index, handle, indent=2)
        handle.write("\n")

    for path in [index_path, shipped, cmsis]:
        log(f"wrote {path} {os.path.getsize(path)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
