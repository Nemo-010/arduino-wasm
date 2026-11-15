#!/usr/bin/env python3
"""Produce the ARM assets the page loads: the wasm tools and a sysroot subset.

Two kinds of input, one output directory.

The tools are ours: scripts/build-arm-tools.py builds cc1, cc1plus, as, ld,
objcopy and ar for wasm32 from GNU sources. This script only copies them into
web/tools/arm/ and gzips the .wasm halves, because the page decompresses them
with the browser's own DecompressionStream. Nothing is rebuilt here.

The sysroot is ARM's: the arm-none-eabi 9-2019-q4-major toolchain release that
Seeed's nRF52 platform declares as its dependency. It carries the newlib
headers, libc_nano, libm, libnosys, libgcc and the Cortex-M4F crt objects that
a sketch links against. It is 494 MB, and the page needs 18 MB of it, so the
subset is named below and asserted after extraction. Downloading 116 MB to
throw away 96% of it is deliberate: the alternative is trusting a hand-made
archive, and this one can be checked against the hash the board index publishes.

The vendor's toolchain lives at lib/gcc/arm-none-eabi/9.2.1. Our cc1plus was
configured with --prefix=/sysroot, so it looks in 9.2.0, the FSF release of the
same series. The subset is written to 9.2.0 so the compiler finds its own
headers without being told where they are.

    python3 scripts/make-arm-assets.py [--force] [--skip-sysroot]
"""

import argparse
import gzip
import hashlib
import os
import shutil
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET = os.path.join(ROOT, "web", "tools", "arm")
BUILD = os.path.join(ROOT, "build", "arm-wasm")

# The Adafruit board-index release that Seeed's index points at for
# x86_64-pc-linux-gnu. The index publishes an MD5; the SHA-256 below was
# computed from that download and is what this script enforces.
SYSROOT_URL = ("https://github.com/adafruit/arduino-board-index/releases/download/"
               "build-tools/gcc-arm-none-eabi-9-2019-q4-major-x86_64-linux.tar.bz2")
SYSROOT_SHA256 = "bcd840f839d5bf49279638e9f67890b2ef3a7c9c7a9b25271e83ec4ff41d177a"
SYSROOT_MD5 = "fe0029de4f4ec43cf7008944e34ff8cc"
SYSROOT_SIZE = 116802378

# (toolchain path, path inside the page's sysroot). The vendor ships 9.2.1 and
# our compiler looks in 9.2.0, so that is the only place the two names differ.
VENDOR = "arm-none-eabi"
GCC_VENDOR = "9.2.1"
GCC_OURS = "9.2.0"
SUBSET = [
    ("arm-none-eabi/include", "arm-none-eabi/include"),
    ("lib/gcc/arm-none-eabi/%s/include" % GCC_VENDOR,
     "lib/gcc/arm-none-eabi/%s/include" % GCC_OURS),
    ("lib/gcc/arm-none-eabi/%s/include-fixed" % GCC_VENDOR,
     "lib/gcc/arm-none-eabi/%s/include-fixed" % GCC_OURS),
    ("lib/gcc/arm-none-eabi/%s/thumb/v7e-m+fp/hard" % GCC_VENDOR,
     "lib/gcc/arm-none-eabi/%s/thumb/v7e-m+fp/hard" % GCC_OURS),
    ("arm-none-eabi/lib/nano.specs", "arm-none-eabi/lib/nano.specs"),
    ("arm-none-eabi/lib/nosys.specs", "arm-none-eabi/lib/nosys.specs"),
    ("arm-none-eabi/lib/thumb/v7e-m+fp/hard", "arm-none-eabi/lib/thumb/v7e-m+fp/hard"),
    # The C++ headers and the two archives the platform's own core needs:
    # HardwarePWM.h includes <atomic>, so a header-only subset does not compile
    # the board's Arduino.h at all. The vendor keeps the C++ version directory,
    # so the driver passes it with -isystem rather than relying on --prefix.
    ("arm-none-eabi/include/c++", "arm-none-eabi/include/c++"),
]

# A sysroot that lost its linker scripts or its crt objects still has the right
# file count. Name the paths a link actually needs.
REQUIRED = [
    "arm-none-eabi/include/stdio.h",
    "arm-none-eabi/include/stdint.h",
    "arm-none-eabi/lib/nano.specs",
    "arm-none-eabi/lib/nosys.specs",
    "arm-none-eabi/lib/thumb/v7e-m+fp/hard/libc_nano.a",
    "arm-none-eabi/lib/thumb/v7e-m+fp/hard/libm.a",
    "arm-none-eabi/lib/thumb/v7e-m+fp/hard/libnosys.a",
    "arm-none-eabi/lib/thumb/v7e-m+fp/hard/crt0.o",
    "lib/gcc/arm-none-eabi/%s/include/stdarg.h" % GCC_OURS,
    "lib/gcc/arm-none-eabi/%s/thumb/v7e-m+fp/hard/libgcc.a" % GCC_OURS,
    "lib/gcc/arm-none-eabi/%s/thumb/v7e-m+fp/hard/crtbegin.o" % GCC_OURS,
    "lib/gcc/arm-none-eabi/%s/thumb/v7e-m+fp/hard/crti.o" % GCC_OURS,
    "arm-none-eabi/include/c++/%s/atomic" % GCC_VENDOR,
    "arm-none-eabi/include/c++/%s/arm-none-eabi/thumb/v7e-m+fp/hard/bits/c++config.h" % GCC_VENDOR,
    "arm-none-eabi/lib/thumb/v7e-m+fp/hard/libstdc++_nano.a",
    "arm-none-eabi/lib/thumb/v7e-m+fp/hard/libsupc++_nano.a",
]

TOOLS = ["cc1", "cc1plus", "as", "ld", "objcopy", "ar"]

# The missing multilibs are the honest limit of this subset: a board built for
# single-precision softfp or for an M0 would need a different directory, and
# the page says so instead of failing to link.
MULTILIB = "thumb/v7e-m+fp/hard"


def log(message):
    sys.stdout.write(message + "\n")
    sys.stdout.flush()


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def md5(path):
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def gzip_file(source, destination):
    with open(source, "rb") as reader:
        with gzip.GzipFile(filename="", mode="wb", fileobj=open(destination, "wb"), mtime=0) as writer:
            shutil.copyfileobj(reader, writer)


def stage_tools():
    out = os.path.join(BUILD, "out")
    missing = [name for name in TOOLS
               if not os.path.exists(os.path.join(out, name + ".wasm"))
               or not os.path.exists(os.path.join(out, name + ".mjs"))]
    if missing:
        raise SystemExit("missing %s in %s; run: python3 scripts/build-arm-tools.py all"
                         % (", ".join(missing), out))
    os.makedirs(TARGET, exist_ok=True)
    for name in TOOLS:
        source_wasm = os.path.join(out, name + ".wasm")
        source_mjs = os.path.join(out, name + ".mjs")
        gzip_file(source_wasm, os.path.join(TARGET, name + ".wasm.gz"))
        shutil.copyfile(source_mjs, os.path.join(TARGET, name + ".mjs"))
        log("  %-9s glue %8d  wasm %9d -> gz %8d" % (
            name, os.path.getsize(source_mjs), os.path.getsize(source_wasm),
            os.path.getsize(os.path.join(TARGET, name + ".wasm.gz"))))


def fetch_sysroot(force):
    cache = os.path.join(BUILD, "sysroot-src")
    os.makedirs(cache, exist_ok=True)
    archive = os.path.join(cache, "arm-gcc-9.tar.bz2")
    if force or not os.path.exists(archive) or os.path.getsize(archive) != SYSROOT_SIZE:
        log("  downloading %s" % SYSROOT_URL)
        with urllib.request.urlopen(SYSROOT_URL, timeout=1800) as response:
            with open(archive + ".part", "wb") as handle:
                shutil.copyfileobj(response, handle)
        os.replace(archive + ".part", archive)
    size = os.path.getsize(archive)
    if size != SYSROOT_SIZE:
        raise SystemExit("archive is %d bytes, the index says %d" % (size, SYSROOT_SIZE))
    digest = sha256(archive)
    if digest != SYSROOT_SHA256:
        raise SystemExit("sha256 %s, expected %s" % (digest, SYSROOT_SHA256))
    # The board index publishes this MD5 and it is what Seeed's installer
    # checks, so agreeing with it is a second, independent claim about the same
    # bytes rather than a restatement of our own hash.
    archive_md5 = md5(archive)
    if archive_md5 != SYSROOT_MD5:
        raise SystemExit("md5 %s, the index says %s" % (archive_md5, SYSROOT_MD5))
    log("  %s verified (%d bytes, sha256 %s…, md5 matches the index)"
        % (os.path.basename(archive), size, digest[:16]))
    return archive


def unpack_sysroot(archive):
    staged = os.path.join(BUILD, "sysroot")
    if os.path.isdir(staged):
        shutil.rmtree(staged)
    os.makedirs(staged)
    keep = 0
    with tarfile.open(archive, "r:bz2") as tar:
        members = tar.getmembers()
        if not members:
            raise SystemExit("archive is empty")
        prefix = members[0].name.split("/")[0] + "/"
        for source, destination in SUBSET:
            # member names carry the archive's root directory; the subset paths
            # are written relative to it, so match with the prefix and slice
            # without it or every file lands on its directory.
            match = prefix + source
            matched = 0
            for member in members:
                if member.name == match or member.name.startswith(match + "/"):
                    if not member.isfile() and not member.isdir():
                        continue
                    relative = member.name[len(prefix):]
                    offset = relative[len(source):]
                    target = os.path.join(staged, destination + offset)
                    if member.isdir():
                        os.makedirs(target, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with tar.extractfile(member) as reader:
                        with open(target, "wb") as writer:
                            shutil.copyfileobj(reader, writer)
                    matched += 1
                    keep += 1
            if not matched:
                # A renamed directory upstream must stop the build, not quietly
                # produce a sysroot without it.
                raise SystemExit("%s is not in the archive any more" % source)
    missing = [path for path in REQUIRED if not os.path.exists(os.path.join(staged, path))]
    if missing:
        raise SystemExit("staged sysroot is missing\n  " + "\n  ".join(missing))
    return staged, keep


def pack_sysroot(staged):
    destination = os.path.join(TARGET, "sysroot.tar.gz")
    names = []
    for root, _directories, files in os.walk(staged):
        for name in files:
            full = os.path.join(root, name)
            names.append((os.path.relpath(full, staged), full))
    names.sort()
    with gzip.GzipFile(filename="", mode="wb", fileobj=open(destination, "wb"), mtime=0) as writer:
        with tarfile.open(fileobj=writer, mode="w") as tar:
            for relative, full in names:
                info = tar.gettarinfo(full, arcname="sysroot/" + relative)
                info.mtime = 0
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                with open(full, "rb") as handle:
                    tar.addfile(info, handle)
    raw = sum(os.path.getsize(full) for _relative, full in names)
    log("  sysroot.tar.gz %d files, %d bytes raw -> %d bytes gzipped"
        % (len(names), raw, os.path.getsize(destination)))
    return destination, len(names), raw


def write_provenance(tools, sysroot, count, raw):
    path = os.path.join(TARGET, "PROVENANCE.md")
    lines = [
        "# ARM assets",
        "",
        "Everything here comes from a script, and the script is in the repository:",
        "",
        "- `python3 scripts/build-arm-tools.py all` builds the six wasm tools from",
        "  GNU binutils 2.42 and GCC 9.2.0 sources with Emscripten 4.0.10.",
        "- `python3 scripts/make-arm-assets.py` copies them here and writes the sysroot.",
        "",
        "These files are in the tree:",
        "",
        "| file | bytes | sha256 |",
        "| --- | --- | --- |",
    ]
    for name in sorted(os.listdir(TARGET)):
        full = os.path.join(TARGET, name)
        if not os.path.isfile(full) or name == "PROVENANCE.md":
            continue
        lines.append("| `%s` | %d | `%s` |" % (name, os.path.getsize(full), sha256(full)))
    lines += [
        "",
        "## The tools",
        "",
        "cc1 and cc1plus are GCC's own front ends, so `.c` and `.cpp` both compile.",
        "`as`, `ld`, `objcopy` and `ar` are binutils. The `.mjs` files are",
        "Emscripten's glue, unmodified apart from being renamed from the",
        "suffix-less name emcc emits.",
        "",
        "The compilers were built with `--prefix=/sysroot`, so they look for their",
        "own headers in `/sysroot/lib/gcc/arm-none-eabi/` + version. That is why",
        "the sysroot in this directory uses version " + GCC_OURS + " where the",
        "vendor's tree says " + GCC_VENDOR + "; the contents are the vendor's.",
        "",
        "## The sysroot",
        "",
        "`sysroot.tar.gz` is the subset of ARM's",
        "`gcc-arm-none-eabi-9-2019-q4-major-x86_64-linux` release that a Cortex-M4F",
        "sketch needs: %d files, %d bytes uncompressed." % (count, raw),
        "",
        "Downloaded from:",
        "",
        "    " + SYSROOT_URL,
        "",
        "Checked against two independent claims about the same bytes: the SHA-256",
        "pinned in `scripts/make-arm-assets.py`, and the MD5 `" + SYSROOT_MD5 + "`",
        "that Seeed's package index publishes for it.",
        "",
        "The vendor's release identifies itself as GCC 9.2.1",
        "(`arm-none-eabi-g++ (GNU Tools for Arm Embedded Processors 9-2019-q4-major)",
        "9.2.1 20191025 (release) [ARM/arm-9-branch revision 277599]`), which is",
        "why the compiler built for the page is FSF GCC 9.2.0 rather than 9.3.0:",
        "same series, so the headers and libgcc agree.",
        "",
        "## The multilib, and the C++ runtime",
        "",
        "Only the " + MULTILIB + " multilib is included, because that is what the",
        "XIAO nRF52840 and the other nRF52 boards in that platform use",
        "(`-mcpu=cortex-m4 -mfloat-abi=hard -mfpu=fpv4-sp-d16`). A board that needs",
        "another multilib does not link, and the driver says which one it wanted",
        "instead of failing inside ld.",
        "",
        "The C++ runtime is the vendor's own, and it is here:",
        "`libstdc++.a`, `libstdc++_nano.a`, `libsupc++.a` and `libsupc++_nano.a`.",
        "`web/arm-driver.js` adds `-lstdc++ -lsupc++` for a C++ link, or the",
        "`_nano` pair when the recipe asks for `--specs=nano.specs`, which is what",
        "g++ itself would do.",
        "",
    ]
    with open(path, "w") as handle:
        handle.write("\n".join(lines))
    log("  PROVENANCE.md written (%d files listed)" % len(tools))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="download the sysroot again")
    parser.add_argument("--skip-sysroot", action="store_true", help="only stage the tools")
    args = parser.parse_args()

    os.makedirs(TARGET, exist_ok=True)
    log("== tools")
    stage_tools()
    if args.skip_sysroot:
        return
    log("== sysroot")
    archive = fetch_sysroot(args.force)
    staged, count = unpack_sysroot(archive)
    _path, count, raw = pack_sysroot(staged)
    write_provenance(TOOLS, staged, count, raw)


if __name__ == "__main__":
    main()
