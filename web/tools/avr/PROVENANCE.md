# The wasm AVR toolchain this page runs

These files are not built here. They are the release assets of
[`startabit/avr-gcc-wasm`](https://github.com/startabit/avr-gcc-wasm), release
`v1`, downloaded and checksum-verified by `scripts/fetch-avr-tools.py`. That
project compiles GCC 7.3.0 with Arduino's `atmel-patches-gcc-7.3.0-arduino2`
patch and binutils 2.42 to WebAssembly using Emscripten 4.0.10.

The page ships these bytes so that a compile needs no network and no server.

| file | bytes | sha256 |
| --- | --- | --- |
| `cc1plus.wasm.gz` | 4,376,836 | `7e36e95f26f3934a4dc86b9d984de1e5e89df80f794347d176d6dff646eb554f` |
| `as.wasm.gz` | 289,495 | `8fd59073e4e861bca4016412a944dd6049c957b91deb2cea652b578d45f0242d` |
| `ld.wasm.gz` | 356,333 | `6ae23384697ce27858d71f8f3eccab6607ff08b5e688f90e81e918a44747ff9b` |
| `objcopy.wasm.gz` | 270,038 | `e9b8a977a9f297225c6b512da1b63d29150dc0593d4cf185fe3576e115fe1083` |
| `sysroot.tar.gz` | 939,045 | `51c5d54ee437f1c0a78032c4f122cae0184a9ebf478312e46f175b2769192c22` |
| `cc1plus.mjs` | 108,686 | `1d0d11037c051f8af31b0cc20d595be9bb7caf23e7d1d567c60e0e5f7f0ee8b6` |
| `as.mjs` | 66,925 | `61bbed90ca23c1eb091674a14853e0cef8d2ed6bbfa1b259390210514b603abc` |
| `ld.mjs` | 72,705 | `52924d1c389bffb3301288e191e65289c002a9c2ef5401e2472c536d077766a7` |
| `objcopy.mjs` | 67,915 | `8d6bf1179c349a21845201c3750c5d6bae4847293b97b8a4d8894da7d5a1516d` |
| `manifest.json` | 836 | `f81ca6a24609fb96386cf58b9aac1d00393a36526ff5200f6710b8c02d95c69e` |

The same table is pinned in `scripts/fetch-avr-tools.py`; that script refuses a
download whose hash differs, so a changed upstream release fails loudly instead
of arriving silently.

## What is missing from the release, and what stands in for it

The release ships four programs: `cc1plus`, `as`, `ld`, `objcopy`. A normal
avr-gcc installation also provides a driver (`avr-g++`/`avr-gcc`), `ar`, `size`,
and `ctags`. `web/avr-driver.js` supplies the driver, `ar` and `size`;

- the driver translates `-mmcu=<device>` into the architecture name `cc1plus`
  accepts plus the device macro `avr/io.h` selects on,
- `ar` records the member list and expands it at link time,
- `size` reads ELF section headers and prints the text `avr-size -A` prints.

`ctags` is a stand-in that exits 0 and prints nothing. That is a named
limitation: a sketch that calls a function before defining it will not be given
a prototype, and will fail to compile.

## The sysroot

`sysroot.tar.gz` carries a GCC sysroot for AVR (avr-libc 2.0.0, `libc.a`,
`libm.a`, `libgcc.a`, `crtatmega328p.o`, linker scripts) plus Arduino AVR core
1.8.8 and seven libraries precompiled with Arduino's own native avr-gcc. It has
no C++ standard library: no `libstdc++.a`, no `libsupc++.a`, and no
`avr/include/c++`. The driver therefore compiles with `-fno-rtti`, and a sketch
that needs `typeid` or `dynamic_cast` will not link.
