#!/usr/bin/env python3
"""Build binutils and GCC for arm-none-eabi, hosted in WebAssembly.

This is the ARM counterpart of what startabit/avr-gcc-wasm does for AVR: the
cross compiler, assembler, linker and objcopy are compiled to wasm so they can
run in a page instead of needing an x86-64 host. The recipe is theirs
(scripts/build.sh in that repository, which follows ajeetjain94608/
avr-toolchain-wasm); only the target changes.

Binutils comes first because it needs no target libraries, so it can be built
and tested before GCC. GCC needs GMP, MPFR and MPC, which are x86-64 ELF on this
machine and so are built for wasm too (the hostlibs stage). Only the compiler
proper is built: the page answers the gcc driver's invocation itself, as
web/avr-driver.js does for AVR.

Usage:
    python3 scripts/build-arm-tools.py sources    # download and unpack
    python3 scripts/build-arm-tools.py binutils   # configure and build
    python3 scripts/build-arm-tools.py hostlibs   # GMP, MPFR, MPC for wasm
    python3 scripts/build-arm-tools.py gcc        # cc1 and cc1plus
    python3 scripts/build-arm-tools.py install    # copy tools to build/arm-wasm/out

Emscripten 4.0.10 is required, the version the AVR toolchain was built with.
Set EMSDK to the emsdk checkout (default: .scratch/toolchain/emsdk). Nothing
here writes outside build/arm-wasm.
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

GCC_VERSION = "9.2.0"
GCC_URL = "https://ftp.gnu.org/gnu/gcc/gcc-9.2.0/gcc-9.2.0.tar.xz"
# Seeed's nRF52 platform asks for arm-none-eabi-gcc "9-2019q4", which measures
# as 9.2.1 (arm-9-branch revision 277599). 9.2.0 is the FSF release of that same
# series, so its headers and libgcc match the vendor sysroot the page mounts.
GCC_SHA256 = "ea6ef08f121239da5695f76c9b33637a118dcf63e24164422231917fa61fb206"

# GCC 7.3 cannot use the host's GMP, MPFR and MPC: those are x86-64 ELF. Each
# is built for wasm first, from generic C with the assembler optimisations off.
# The hashes are cross-checked against startabit/avr-gcc-wasm's SHA256SUMS,
# which pins the same files, so a bad mirror cannot slip through unnoticed.
HOST_LIBS = [
    ("gmp", "6.2.1", "https://ftp.gnu.org/gnu/gmp/gmp-6.2.1.tar.xz",
     "fd4829912cddd12f84181c3451cc752be224643e87fac497b69edddadc49b4f2"),
    ("mpfr", "4.1.0", "https://ftp.gnu.org/gnu/mpfr/mpfr-4.1.0.tar.xz",
     "0c98a3f1732ff6ca4ea690552079da9c597872d30e96ec28414ee23c95558a7f"),
    ("mpc", "1.2.1", "https://ftp.gnu.org/gnu/mpc/mpc-1.2.1.tar.gz",
     "17503d2c395dfcf106b622dc142683c1199431d095367c6aacba6eec30340459"),
]
# Which packages need --disable-assembly. MPFR and MPC contain no assembly and
# configure refuses --disable-assembly, so only GMP is given it.
NO_ASSEMBLY = {"gmp"}

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
    # Emscripten's libc already declares psignal and strsignal; libiberty's
    # cross-compile guess is that they are absent and defines them again, which
    # is a hard error (strsignal.c:554: conflicting types for 'psignal' in GCC,
    # and the same file in binutils). Both builds need this, so it is set for
    # every stage rather than for binutils alone.
    env["ac_cv_func_psignal"] = "yes"
    env["ac_cv_func_strsignal"] = "yes"
    env["PATH"] = os.pathsep.join(
        [
            os.path.join(EMSDK, "upstream", "emscripten"),
            os.path.join(EMSDK, "upstream", "bin"),
            os.path.join(EMSDK, "node", "bin"),
            env.get("PATH", ""),
        ]
    )
    return env


def fetch(url, sha256sum, destination):
    """Download url to destination unless it is there, then check the hash."""
    if not os.path.exists(destination):
        log("downloading " + url)
        with urllib.request.urlopen(url) as response, open(destination + ".part", "wb") as out:
            shutil.copyfileobj(response, out)
        os.replace(destination + ".part", destination)
    actual = sha256(destination)
    if actual != sha256sum:
        raise SystemExit(
            "%s hash %s is not the pinned %s" % (os.path.basename(destination), actual, sha256sum)
        )
    log("%s verified (%d bytes)" % (os.path.basename(destination), os.path.getsize(destination)))


def unpack(archive):
    base = os.path.basename(archive)
    name = base.replace(".tar.xz", "").replace(".tar.gz", "")
    if not os.path.isdir(os.path.join(SRC, name)):
        run(["tar", "xf", base], cwd=SRC)
    return os.path.join(SRC, name)


def stage_sources():
    os.makedirs(SRC, exist_ok=True)
    packages = [
        (BINUTILS_URL, BINUTILS_SHA256, "binutils-%s.tar.xz" % BINUTILS_VERSION),
        (GCC_URL, GCC_SHA256, "gcc-%s.tar.xz" % GCC_VERSION),
    ] + [(url, digest, "%s-%s.%s" % (name, version, "tar.gz" if url.endswith(".tar.gz") else "tar.xz")) for name, version, url, digest in HOST_LIBS]
    for url, digest, filename in packages:
        fetch(url, digest, os.path.join(SRC, filename))
        unpack(os.path.join(SRC, filename))
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


def stage_hostlibs():
    """GMP, MPFR and MPC for wasm32, which GCC links against at configure time."""
    env = emscripten_env()
    prefix = os.path.join(WORK, "hostlibs")
    os.makedirs(prefix, exist_ok=True)
    for name, version, _url, _digest in HOST_LIBS:
        source = os.path.join(SRC, "%s-%s" % (name, version))
        build = os.path.join(WORK, "build-" + name)
        if os.path.isdir(build):
            shutil.rmtree(build)
        os.makedirs(build)
        args = [
            os.path.join(EMSDK, "upstream", "emscripten", "emconfigure"),
            os.path.join(source, "configure"),
            "--build=x86_64-pc-linux-gnu",
            "--host=none",
            "--disable-shared",
            "--enable-static",
            "--prefix=" + prefix,
        ]
        if name in NO_ASSEMBLY:
            args.append("--disable-assembly")
        # MPFR and MPC find the library before it.
        if name in ("mpfr", "mpc"):
            args.append("--with-gmp=" + prefix)
        if name == "mpc":
            args.append("--with-mpfr=" + prefix)
        run(args + ["CC_FOR_BUILD=gcc"], cwd=build, env=env, log_file=os.path.join(build, "configure.log"))
        run(
            [os.path.join(EMSDK, "upstream", "emscripten", "emmake"), "make", "-j%d" % (os.cpu_count() or 4), "install"],
            cwd=build,
            env=env,
            log_file=os.path.join(build, "make.log"),
        )
        log("%s-%s installed into %s" % (name, version, prefix))


def stage_gcc():
    """cc1 and cc1plus for arm-none-eabi, as wasm modules.

    Only the compiler proper, not the gcc driver: the page answers the driver's
    invocation itself, the way web/avr-driver.js does for AVR, so the driver
    binary has no purpose here. -std=gnu++98 is for GCC 7.3's own sources, which
    predate the C++11 the host compiler now defaults to.
    """
    env = emscripten_env()
    prefix = os.path.join(WORK, "hostlibs")
    build = os.path.join(WORK, "build-gcc")
    # A build tree configured for another GCC version must not be reused: make
    # would happily link the old objects and produce a compiler that reports
    # the wrong version. Record which source the tree belongs to.
    stamp = os.path.join(build, ".gcc-version")
    if os.path.isdir(build):
        recorded = open(stamp).read().strip() if os.path.exists(stamp) else ""
        if recorded != GCC_VERSION:
            log("discarding %s (configured for %s, not %s)" % (build, recorded or "unknown", GCC_VERSION))
            shutil.rmtree(build)
    os.makedirs(build, exist_ok=True)
    if not os.path.exists(stamp):
        with open(stamp, "w") as handle:
            handle.write(GCC_VERSION + "\n")
    jobs = "-j%d" % (os.cpu_count() or 4)
    configure = os.path.join(SRC, "gcc-%s" % GCC_VERSION, "configure")
    if not os.path.exists(os.path.join(build, "Makefile")):
        run(
            [
                os.path.join(EMSDK, "upstream", "emscripten", "emconfigure"),
                configure,
                "--build=x86_64-pc-linux-gnu",
                "--host=i686-pc-linux-gnu",
                "--target=" + TARGET,
                "--prefix=/sysroot",
                "--enable-languages=c,c++",
                "--disable-nls",
                "--disable-shared",
                "--disable-bootstrap",
                "--disable-lto",
                "--disable-plugin",
                "--disable-doc",
                "--without-isl",
                "--with-dwarf2",
                # No target C library at configure time: the page supplies the
                # vendor package's headers and libraries as a sysroot.
                "--without-headers",
                "--with-gmp=" + prefix,
                "--with-mpfr=" + prefix,
                "--with-mpc=" + prefix,
                "CC_FOR_BUILD=gcc",
                "CXX_FOR_BUILD=g++",
                "CFLAGS=-O2",
                "CXXFLAGS=-O2 -std=gnu++14 -Wno-register -Wno-deprecated",
                "LDFLAGS=" + EM_LINK,
            ],
            cwd=build,
            env=env,
            log_file=os.path.join(build, "configure.log"),
        )
    emmake = os.path.join(EMSDK, "upstream", "emscripten", "emmake")
    # The host-side libraries first, then the build machine's own copies for
    # GCC's generator programs (genconstants, gengtype, ...), which are native
    # Linux binaries and are compiled by CC_FOR_BUILD, not by emcc.
    run(
        [emmake, "make", jobs, "configure-gcc", "all-libiberty", "all-libcpp",
         "all-libdecnumber", "all-libbacktrace", "all-build-libiberty", "all-build-libcpp",
         "all-build-fixincludes"],
        cwd=build,
        env=env,
        log_file=os.path.join(build, "make-libs.log"),
    )
    run(
        [emmake, "make", jobs, "-C", "gcc", "cc1", "cc1plus",
         "CC_FOR_BUILD=gcc", "CXX_FOR_BUILD=g++",
         "CFLAGS_FOR_BUILD=-O2", "CXXFLAGS_FOR_BUILD=-O2 -std=gnu++11",
         "LDFLAGS_FOR_BUILD=", "ZLIB=-sUSE_ZLIB=1"],
        cwd=build,
        env=env,
        log_file=os.path.join(build, "make-cc1.log"),
    )
    log("cc1 and cc1plus built in " + os.path.join(build, "gcc"))


def stage_install():
    build = os.path.join(WORK, "build-binutils")
    os.makedirs(OUT, exist_ok=True)
    tools = {
        "as": os.path.join(build, "gas", "as-new"),
        "ld": os.path.join(build, "ld", "ld-new"),
        "objcopy": os.path.join(build, "binutils", "objcopy"),
        "ar": os.path.join(build, "binutils", "ar"),
    }
    gcc_build = os.path.join(WORK, "build-gcc", "gcc")
    # The compiler proper, when the gcc stage has run. It is optional here so
    # that a binutils-only build still installs its four tools.
    compilers = {"cc1": os.path.join(gcc_build, "cc1"), "cc1plus": os.path.join(gcc_build, "cc1plus")}
    for name, base in compilers.items():
        if os.path.exists(base):
            tools[name] = base
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
    stages = argv[1:] or ["sources", "binutils", "hostlibs", "gcc", "install"]
    for stage in stages:
        log("== " + stage)
        {
            "sources": stage_sources,
            "binutils": stage_binutils,
            "hostlibs": stage_hostlibs,
            "gcc": stage_gcc,
            "install": stage_install,
        }.get(stage, lambda: (_ for _ in ()).throw(SystemExit("unknown stage " + stage)))()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
