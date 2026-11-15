# ARM assets

Everything here comes from a script, and the script is in the repository:

- `python3 scripts/build-arm-tools.py all` builds the six wasm tools from
  GNU binutils 2.42 and GCC 9.2.0 sources with Emscripten 4.0.10.
- `python3 scripts/make-arm-assets.py` copies them here and writes the sysroot.

These files are in the tree:

| file | bytes | sha256 |
| --- | --- | --- |
| `ar.mjs` | 69100 | `1ad1b423d6a2169eb41db34ddca0a29a86376e367b5e6bca786d268ab8f16256` |
| `ar.wasm.gz` | 243101 | `2065e3466ff5704cd0290b0dd1ea323a792e02d9be0e48f7e539cda282f97d30` |
| `as.mjs` | 66925 | `61bbed90ca23c1eb091674a14853e0cef8d2ed6bbfa1b259390210514b603abc` |
| `as.wasm.gz` | 457092 | `9c98e97e51a4dcb532a2cd39e9bea836e18d5bdd98125422dc427d781df2c362` |
| `cc1.mjs` | 118726 | `94f29c7d89ffb65bfd84ab5d401eabca80815092ccf42fd162f1483e61fd4c86` |
| `cc1.wasm.gz` | 5517318 | `1934c27fa90fab83dfa09bf7253ff24027274cf41c408828d3cad8793752017a` |
| `cc1plus.mjs` | 119934 | `670ec713e20c18ae08fb9232a4f6c80e3627847b07bdbc574a430854db154bf1` |
| `cc1plus.wasm.gz` | 5983526 | `dcdadb974423a236b88268492be967ad50902eecf2e9d2e30d891d1b55c43350` |
| `ld.mjs` | 72705 | `52924d1c389bffb3301288e191e65289c002a9c2ef5401e2472c536d077766a7` |
| `ld.wasm.gz` | 401020 | `f59f02d9601e3937c15eb8d94515a310c9c59153257932776dea2356ca48b65a` |
| `objcopy.mjs` | 67915 | `8d6bf1179c349a21845201c3750c5d6bae4847293b97b8a4d8894da7d5a1516d` |
| `objcopy.wasm.gz` | 305687 | `f8e747ab52dfcf5eb54af3ca61c2555d066d88768424d910bdaaef8bbaf2bfaf` |
| `sysroot.tar.gz` | 5039711 | `04424817f09a220dda6aeb9344b25793a052b0dab4fd7ed2ab30ff72f76ee25b` |

## The tools

cc1 and cc1plus are GCC's own front ends, so `.c` and `.cpp` both compile.
`as`, `ld`, `objcopy` and `ar` are binutils. The `.mjs` files are
Emscripten's glue, unmodified apart from being renamed from the
suffix-less name emcc emits.

The compilers were built with `--prefix=/sysroot`, so they look for their
own headers in `/sysroot/lib/gcc/arm-none-eabi/` + version. That is why
the sysroot in this directory uses version 9.2.0 where the
vendor's tree says 9.2.1; the contents are the vendor's.

## The sysroot

`sysroot.tar.gz` is the subset of ARM's
`gcc-arm-none-eabi-9-2019-q4-major-x86_64-linux` release that a Cortex-M4F
sketch needs: 1463 files, 28801608 bytes uncompressed.

Downloaded from:

    https://github.com/adafruit/arduino-board-index/releases/download/build-tools/gcc-arm-none-eabi-9-2019-q4-major-x86_64-linux.tar.bz2

Checked against two independent claims about the same bytes: the SHA-256
pinned in `scripts/make-arm-assets.py`, and the MD5 `fe0029de4f4ec43cf7008944e34ff8cc`
that Seeed's package index publishes for it.

The vendor's release identifies itself as GCC 9.2.1
(`arm-none-eabi-g++ (GNU Tools for Arm Embedded Processors 9-2019-q4-major)
9.2.1 20191025 (release) [ARM/arm-9-branch revision 277599]`), which is
why the compiler built for the page is FSF GCC 9.2.0 rather than 9.3.0:
same series, so the headers and libgcc agree.

## The multilib, and the C++ runtime

Only the thumb/v7e-m+fp/hard multilib is included, because that is what the
XIAO nRF52840 and the other nRF52 boards in that platform use
(`-mcpu=cortex-m4 -mfloat-abi=hard -mfpu=fpv4-sp-d16`). A board that needs
another multilib does not link, and the driver says which one it wanted
instead of failing inside ld.

The C++ runtime is the vendor's own, and it is here:
`libstdc++.a`, `libstdc++_nano.a`, `libsupc++.a` and `libsupc++_nano.a`.
`web/arm-driver.js` adds `-lstdc++ -lsupc++` for a C++ link, or the
`_nano` pair when the recipe asks for `--specs=nano.specs`, which is what
g++ itself would do.
