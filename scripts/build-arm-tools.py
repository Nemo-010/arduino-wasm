#!/usr/bin/env python3
"""Build binutils for arm-none-eabi, hosted in WebAssembly, with Emscripten.

This is the ARM counterpart of what startabit/avr-gcc-wasm does for AVR: the
cross assembler, linker and objcopy are compiled to wasm so they can run in a
page instead of needing an x86-64 host. The recipe is theirs
(scripts/build.sh in that repository, which follows ajeetjain94608/
avr-toolchain-wasm); only the target changes.

Why binutils first: it is the half of a cross toolchain that needs no target
libraries, so it can be built and tested before GCC. `as` and `ld` are what
decide whether an ARM object and an ELF for a Cortex-M come out.

Usage:
    python3 scripts/build-arm-tools.py sources    # download and unpack
    python3 scripts/build-arm-tools.py binutils   # configure and build
    python3 scripts/build-arm-tools.py install    # copy tools to build/arm-wasm/out

Emscripten 4.0.10 is required, the version the AVR toolchain was built with.
Set EMSDK to the emsdk checkout (default: .scratch/toolchain/emsdk). Nothing
here writes outside build/arm-wasm and .scratch/arm-wasm.
"""

import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request

BINUTILS_VERSION = "2.42"
BINUTILS_URL = "https://ftp.gnu.org/gnu/binutils/binutils-2.42.tar.xz"
BINUTILS_SHA256 = "f6e4d41fd5fc778b06b7891457b3620da5ecea1006c6a4a41ae998109f85a800"

TARGET = "arm-none-eabi"
EMSDK_VERSION = "4.0.10"

# -O2 and a static link; the ES module shape matches what web/avr-assets.js
# loads, so the page can treat an ARM tool exactly like an AVR one.
EM_LINK = (
    "-O2 -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_ES6=1 "
    "-sEXPORT_NAME=createTool -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 "
    "-sEXIT_RUNTIME=1 -sENVIRONMENT=web,worker,node "
    "-sEXPORTED_RUNTIME_METHODS=FS,callMain -sSTACK_SIZE=8MB"
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "build", "arm-wasm")
SRC = os.path.join(WORK, "src")
OUT = os.path.join(WORK, "out")
EMSDK = os.environ.get("EMSDK") or os.path.join(
    os.path.dirname(ROOT), ".scratch", "toolchain", "emsdk"
)


def log(message):
    print(message, flush=True)


def run(argv, cwd=None, env=None, log_file=None):
    """Run a command, keeping its full output in log_file and its exit code."""
    log("  $ " + " ".join(argv[:6]) + (" ..." if len(argv) > 6 else ""))
    if log_file:
        with open(log_file, "wb") as handle:
            code = subprocess.call(argv, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
    else:
        code = subprocess.call(argv, cwd=cwd, env=env)
    if code != 0:
        tail = ""
        if log_file:
            with open(log_file, "rb") as handle:
                data = handle.read()
            tail = data[-4000:].decode("utf-8", "replace")
        raise SystemExit(
            "%s failed with exit %d%s" % (argv[0], code, ("\n" + tail) if tail else "")
        )
    return code


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def emscripten_env():
    """The environment emconfigure would set, from the same layout emsdk uses."""
    if not os.path.isdir(EMSDK):
        raise SystemExit(
            "emsdk not found at %s. Set EMSDK to an emsdk checkout with 4.0.10 installed:\n"
            "  git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install 4.0.10"
            % EMSDK
        )
    env = dict(os.environ)
    env["EM_CONFIG"] = os.path.join(EMSDK, ".emscripten")
    env["EMSDK"] = EMSDK
    env["PATH"] = os.pathsep.join(
        [
            os.path.join(EMSDK, "upstream", "emscripten"),
            os.path.join(EMSDK, "upstream", "bin"),
            os.path.join(EMSDK, "node", "bin"),
            env.get("PATH", ""),
        ]
    )
    return env


def stage_sources():
    os.makedirs(SRC, exist_ok=True)
    archive = os.path.join(SRC, "binutils-%s.tar.xz" % BINUTILS_VERSION)
    if not os.path.exists(archive):
        log("downloading " + BINUTILS_URL)
        with urllib.request.urlopen(BINUTILS_URL) as response, open(archive + ".part", "wb") as out:
            shutil.copyfileobj(response, out)
        os.replace(archive + ".part", archive)
    actual = sha256(archive)
    if actual != BINUTILS_SHA256:
        raise SystemExit("binutils archive hash %s is not the pinned %s" % (actual, BINUTILS_SHA256))
    log("binutils-%s.tar.xz verified (%d bytes)" % (BINUTILS_VERSION, os.path.getsize(archive)))
    unpacked = os.path.join(SRC, "binutils-%s" % BINUTILS_VERSION)
    if not os.path.isdir(unpacked):
        run(["tar", "xf", os.path.basename(archive)], cwd=SRC)
    log("sources in " + SRC)


def stage_binutils():
    build = os.path.join(WORK, "build-binutils")
    if os.path.isdir(build):
        shutil.rmtree(build)
    os.makedirs(build)
    env = emscripten_env()
    # Emscripten's libc already declares psignal and strsignal; libiberty's
    # cross-compile guess is that they are absent and defines them again, which
    # is a hard error (strsignal.c:554: conflicting types for 'psignal').
    env["ac_cv_func_psignal"] = "yes"
    env["ac_cv_func_strsignal"] = "yes"
    configure = os.path.join(SRC, "binutils-%s" % BINUTILS_VERSION, "configure")
    # --host=i686-pc-linux-gnu because wasm32 is ILP32, the same choice the AVR
    # recipe makes; --prefix=/sysroot is where the page mounts the toolchain, so
    # ld's built-in search paths resolve there and nowhere host-specific.
    run(
        [
            os.path.join(EMSDK, "upstream", "emscripten", "emconfigure"),
            configure,
            "--build=x86_64-pc-linux-gnu",
            "--host=i686-pc-linux-gnu",
            "--target=" + TARGET,
            "--prefix=/sysroot",
            "--disable-nls",
            "--disable-werror",
            "--disable-gdb",
            "--disable-gdbserver",
            "--disable-sim",
            "--disable-gprof",
            "--disable-gprofng",
            "--disable-plugins",
            "--disable-shared",
            "--enable-static",
            "--disable-libctf",
            "--without-zstd",
            "--without-debuginfod",
            "CC_FOR_BUILD=gcc",
            "CFLAGS=-O2",
            "LDFLAGS=" + EM_LINK,
        ],
        cwd=build,
        env=env,
        log_file=os.path.join(build, "configure.log"),
    )
    run(
        [
            os.path.join(EMSDK, "upstream", "emscripten", "emmake"),
            "make",
            "-j%d" % (os.cpu_count() or 4),
            "all-gas",
            "all-ld",
            "all-binutils",
        ],
        cwd=build,
        env=env,
        log_file=os.path.join(build, "make.log"),
    )
    log("built in " + build)


def stage_install():
    build = os.path.join(WORK, "build-binutils")
    os.makedirs(OUT, exist_ok=True)
    tools = {
        "as": os.path.join(build, "gas", "as-new"),
        "ld": os.path.join(build, "ld", "ld-new"),
        "objcopy": os.path.join(build, "binutils", "objcopy"),
        "ar": os.path.join(build, "binutils", "ar"),
    }
    for name, base in tools.items():
        # emcc writes the ES module as <name> (with no suffix) beside <name>.wasm.
        # The page expects <name>.mjs, the same shape the AVR release uses.
        for source, target in ((base, name + ".mjs"), (base + ".wasm", name + ".wasm")):
            if not os.path.exists(source):
                raise SystemExit("expected %s, which the build did not produce" % source)
            shutil.copy2(source, os.path.join(OUT, target))
    log("tools in " + OUT)
    for entry in sorted(os.listdir(OUT)):
        log("  %-16s %d bytes" % (entry, os.path.getsize(os.path.join(OUT, entry))))


def main(argv):
    stages = argv[1:] or ["sources", "binutils", "install"]
    for stage in stages:
        log("== " + stage)
        {"sources": stage_sources, "binutils": stage_binutils, "install": stage_install}.get(
            stage, lambda: (_ for _ in ()).throw(SystemExit("unknown stage " + stage))
        )()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
