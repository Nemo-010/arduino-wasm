# arduino-cli, compiled to WebAssembly

The Arduino IDE 2 is an Electron app split in two halves. The renderer is the
UI. Everything else is `arduino-cli`, which the IDE spawns as a daemon
(`arduino-ide-extension/src/node/arduino-daemon-impl.ts` runs
`arduino-cli daemon --port 0 --config-file …`) and drives over gRPC on
localhost.

This repository keeps the second half and removes the transport. The same
upstream source is compiled for `GOOS=js`, loaded into a page, and called
directly from JavaScript. There is no daemon, no port and no gRPC: the page
calls the CLI's own service methods, which is what the IDE's gRPC calls land on
anyway (`commands.NewArduinoCoreServer()`).

Index parsing, checksum verification, archive extraction, the on-disk install
layout and library validation are the CLI's own code, unchanged.

## What works

Proven by the tests in this repository, against a real index and real archives:

- `ConfigurationOpen` → `Create` → `Init`, the same start-up the IDE performs.
- Downloading and parsing package indexes, including third-party ones added
  through `board_manager.additional_urls`.
- Downloading and parsing the library index.
- Installing a platform: the core archive, its `toolsDependency` archives, and
  the resulting `hardware/` and `packages/` layout.
- Installing a library into `Arduino/libraries`.
- `LibraryList`, `PlatformSearch`, `BoardListAll`.
- `BoardIdentify` from a USB vendor/product pair, which is what the page feeds
  it from WebSerial.
- Storage in IndexedDB through `web/nodefs.js`, the same shim the tests use.
- Compiling a sketch for AVR in the page, producing a `.hex`, with the real
  builder and the real platform recipes (`test/avr.mjs`, `test/page-compile.mjs`).
- Compiling, assembling and linking for ARM in WebAssembly: `cc1`, `cc1plus`,
  `as`, `ld`, `objcopy` and `ar` for `arm-none-eabi`, built from GCC 9.2.0 and
  GNU binutils 2.42 (`test/arm-tools.mjs`). A whole blink sketch for the XIAO
  nRF52840 is compiled, linked and packaged into a DFU zip through the wasm CLI
  (`test/nrf52.mjs`), and the same pipeline runs in the page
  (`test/page-nrf52.mjs`).

## What does not work

**Upload.** A compile for AVR and for the XIAO nRF52840 now finishes in the
page (see *Compiling on the page*). An upload does not. The last step of an AVR
upload recipe is `avrdude`, a child process, and `web/avr-driver.js` answers it
with a refusal that says so; the nRF52 recipe asks for
`adafruit-nrfutil dfu serial`, which needs a serial port, and nothing here
speaks STK500 or DFU to a board yet. WebSerial can open the port and identify
the board.

**Compiling for an architecture with no wasm compiler.** The exec seam is the
only place a toolchain is reached, so a platform compiles on the page when a
wasm build of its compiler exists, and the same driver shape works for any of
them. Two exist now — AVR, taken from an existing wasm build, and ARM, built
here. A platform whose compiler ships only as a binary blob without source
still cannot compile.

The board run is reproduced by `NETWORK=1 node test/nrf52.mjs`. It adds Seeed's
board URL, installs `Seeeduino:nrf52@1.1.9`, writes blink and compiles it for
the XIAO nRF52840. Measured 2026-11-15 on this machine, the run takes about
90 s and ends with a linked image and a DFU package:

```
ok   the image is ARM (e_machine 40)
ok   the entry point is a Thumb address (0x28639)
ok   the word before the reset handler is a RAM stack pointer (0x20040000)
ok   manifest.json is byte-identical to adafruit-nrfutil's (466 bytes)
```

Against the real servers:

- the 290,172 byte index fetched over TLS and parsed into 14 releases of
  `Seeeduino:nrf52`, five of them boards, including "Seeed XIAO nRF52840";
- the platform and all three tool dependencies installed into the wasm
  filesystem: 2,451 core files and 13,905 tool files. The x86-64
  `arm-none-eabi-g++` it installs (1,153,656 bytes, `e_machine 62`) is never
  executed: the exec seam answers with wasm tools instead;
- `cc1plus` compiled the sketch, `as` assembled it, `ld` linked it, `objcopy`
  wrote a 75,513 byte Intel HEX with 1,681 records and the recipe's own
  `adafruit-nrfutil genpkg` step produced a 27,632 byte DFU package;
- the CLI's size line reads `Sketch uses 26816 bytes (3%) of program storage
  space. Maximum is 811008 bytes.` and `Global variables use 5176 bytes (2%)
  of dynamic memory` — 2,492 bytes of `.data` plus 2,684 bytes of `.bss`.

The script exits 0 (compiled), 2 (a download was refused), 3 (reached the
toolchain and could not start it) or 1 (anything else), so the outcome is
checkable without reading prose.

**Board URLs and archives without CORS headers.** A server only sends
`access-control-allow-origin` when the request carries an `Origin` header, so
these were measured with one. Results, 2026-11-13, HTTP status and header
presence:

| URL | status | `access-control-allow-origin` |
| --- | --- | --- |
| `files.seeedstudio.com/.../package_seeeduino_boards_index.json` | 200 | absent |
| `github.com/adafruit/.../releases/download/...` (the ARM toolchain) | 302 → 206 | absent |
| `raw.githubusercontent.com/.../package_esp32_index.json` (control) | 200 | `*` |

So a page can neither read Seeed's index nor download the toolchain archives
that index points at, because those live on GitHub release assets. The control
shows the measurement is sound: the same request shape does get `*` where the
host allows it. The Node harness passes only because Node's fetch does not
enforce CORS.

Installing such a core from the page needs a proxy or a mirror you control.
`downloads.arduino.cc` refuses this sandbox with 403, so its headers could not
be measured here; the Arduino Index cores that use it are untested from a
browser for the same reason.

### The gateway

`scripts/gateway.py` is that proxy, and it is the only piece that has to run
somewhere other than the page:

```
python3 scripts/gateway.py --port 8787
# then set the gateway field in the page, or pass it to a harness:
ARDUINO_CORS_GATEWAY=http://127.0.0.1:8787 node test/gateway.mjs
```

The rewrite happens in Go's transport, so an index, an archive and a resumed
range all go through one wrapper and no caller knows the difference. Set the
variable before the wasm starts: Go's js ABI copies the environment into linear
memory at startup (`wasm_exec.js` writes argv and env into the same block), so
it cannot change afterwards. The page reads the value from `localStorage` and
reloads when you save it.

Requests are `GET /u/<base64url of the target>`. Only `https` targets are
fetched unless `--allow-http` is passed; `Range`, `206`, `Content-Range`,
`ETag`, `Last-Modified` and redirects pass through; a response with no
`Content-Length` is re-framed as chunked so the browser knows where it ends. The
origin's own `access-control-*` headers are dropped in favour of the gateway's,
so the page can read a success and can also read an origin's refusal instead of
seeing an opaque CORS error.

Why not the WebVM route. WebVM runs a Linux with real sockets, so its `curl`
can ride Tailscale's userspace WireGuard. This wasm has no sockets: Go's js
HTTP transport calls `fetch()` directly (`net/http/roundtrip_js.go:130`), which
makes `network.proxy` a no-op, so in-page Tailscale would first mean replacing
`fetch` with a socket API. Both routes end at "some server fetches the URL";
the gateway is the smaller one, and it can sit on your tailnet if you want it
private.

**Port discovery.** The IDE gets serial ports from `serial-discovery` and
`mdns-discovery`, which are separate binaries run as plugins. They cannot run
in a tab, so `Init` reports them as missing. That message is expected. The page
supplies the vendor and product ids from WebSerial instead, which is enough for
`BoardIdentify`.

## Compiling on the page

The page compiles for both boards it ships an index for. Press **Install
arduino:avr** or **Install Seeeduino:nrf52**, choose the board, paste a sketch,
press **Compile**. The result is a `.hex` you can download, plus the CLI's own
size report — and for the XIAO a DFU `.zip` as well, which is what a flasher
consumes.

Nothing is faked at the CLI's boundary: `arduino-cli` runs its real builder,
its real recipes on the real platform, and asks for `avr-g++` or
`arm-none-eabi-g++` the same way it would on a machine with the toolchain
installed. What differs is what answers.

### The seam

The builder starts tools through `go-paths-helper`, a vendored copy of
`github.com/arduino/go-paths-helper` whose `Process.Start`/`Wait` call a hook
(`overlay/wasm/exec_js.go`). Under `GOOS=js` that hook hands the command line to
`globalThis.arduinoExec(request, callback)`. `web/exec.js` installs it and picks
a driver by tool name: `web/avr-driver.js` answers `avr-*` and `avrdude`,
`web/arm-driver.js` answers `arm-none-eabi-*` and `(adafruit-)nrfutil`. Nothing
else in the CLI was changed for this.

Only the toolchain a compile actually reaches is loaded: an AVR session never
decompresses the ARM sysroot, and the other way round.

### The AVR compiler

`web/tools/avr/` holds a wasm build of avr-gcc's own programs — `cc1plus`, `as`,
`ld`, `objcopy` — collected from `startabit/avr-gcc-wasm`, a wasm build of GCC
7.3.0 with Arduino's own patch. `scripts/fetch-avr-tools.py` downloads them,
checks each file against SHA-256 hashes pinned in that script, and fails loudly
if upstream changes. `web/tools/avr/PROVENANCE.md` records the hashes and the
release they came from.

Four programs is not a toolchain, so `web/avr-driver.js` supplies the rest, and
each substitution is a decision with a cost:

| the recipe asks for | what answers | cost |
| --- | --- | --- |
| `avr-g++`, `avr-gcc` | the driver: maps `-mmcu=<device>` to the architecture `cc1plus` accepts and the device macro `avr/io.h` selects on | a device absent from `web/avr-mcus.js` fails |
| `avr-gcc-ar` | the driver records the members; `core.a` is expanded at link time | the archive is not a file the toolchain can inspect |
| `avr-size` | the driver reads ELF section headers and prints what `avr-size -A` prints | only text and data are reported |
| `ctags` | a stand-in that exits 0 and prints nothing | a sketch that calls a function before defining it has no prototype and fails |
| `avrdude` | a refusal | no upload |

`web/avr-mcus.js` is generated, not typed: `scripts/gen-avr-mcus.py` reads
`avr-mcus.def` from the same GCC release and emits 274 devices across 16
architectures, with the macro spelling each device selects on.

### The sysroot

The AVR release ships no headers and no libraries, so the page carries theirs:
`sysroot.tar.gz` contains a GCC sysroot for AVR (avr-libc 2.0.0) and Arduino
AVR core 1.8.8 with seven libraries, precompiled with Arduino's own native
avr-gcc. For ARM the vendor package does ship them, so
`scripts/make-arm-assets.py` cuts the sysroot out of Seeed's own tarball
(`web/tools/arm/sysroot.tar.gz`, 1,463 files). The driver unpacks the one it
needs into the filesystem on the first tool call; both are already committed,
so a compile needs no network.

### What it cannot do

- **No C++ standard library in the AVR sysroot** — no `libstdc++.a`, no
  `avr/include/c++`. The driver compiles with `-fno-rtti`, so `typeid` and
  `dynamic_cast` do not link. Sketches that avoid them compile.
- **AVR C files are compiled as C++**, because only `cc1plus` was built to
  wasm for that target. `-fpermissive` covers most of it. `hooks.c` uses
  `__attribute__((alias(...)))`, which C++ cannot express on a definition, so
  the driver rewrites that pattern and logs every rewrite. Any other C
  construct C++ cannot express fails loudly.
- **Only `thumb/v7e-m+fp/hard` is in the ARM sysroot.** That is the multilib
  the XIAO nRF52840 links against. A soft-float or Cortex-M0 board would need
  its own, and the driver says which one it wanted rather than failing inside
  `ld`.
- **No upload**, for either board. `avrdude` and `adafruit-nrfutil dfu serial`
  are not implemented; the DFU *packaging* step is (`web/nrfutil.js`).
- **Two toolchains, two boards.** The seam is general; the drivers cover AVR
  and the nRF52 boards of the Seeed platform.

### The index the page carries

`web/indexes/avr/` holds a package index for `arduino:avr@1.8.6` and the real
Arduino AVR core archive. Its tool entries are dummy archives that are never
executed — `web/avr-driver.js` answers every tool call — so the installer finds
the tools its index promises. `web/indexes/avr/README.md` says so in place.
`web/indexes/nrf52/` does the same for `Seeeduino:nrf52@1.1.9`, and there the
CMSIS archive is real because `ld` reads its `.a`; `web/indexes/nrf52/README.md`
says what is real and what is a stand-in.

The two indexes must not share a file name. `arduino-cli` saves each one under
the basename of its URL, so a second `package_index.json` overwrites the first
in its data directory and that platform disappears; the AVR one is
`package_index.json` and the nRF52 one is `nrf52_index.json`.

The index's URLs point at `https://arduino-wasm.invalid/`, a host that does not
exist. `arduino-cli` uses that URL verbatim, so the page installs a `fetch` shim
that maps the origin onto its own directory. The shim loads with
`XMLHttpRequest`, because `fetch` is refused on `file://` and the page has to
work when someone opens `web/index.html` directly.

That shim is shared with the tests: `test/page-compile.mjs` runs
`createIndexFetch` with a disk `read` instead of a socket, so a mapping bug
fails a test rather than a user's compile.

## Files

```
overlay/                    files copied over the upstream clone
  wasm/main.go              entry point: the JS bridge
  internal/…                js-specific replacements (locales, sync, tool host)
scripts/update.py           clone + patch + build; the only update mechanism
scripts/serve.py            static server, correct wasm content type
scripts/build-ide.py        builds the arduino-ide frontend for the browser
scripts/fetch-avr-tools.py  downloads the wasm AVR toolchain, verifies hashes
scripts/make-avr-index.py   builds the package index the page installs from
scripts/gen-avr-mcus.py     generates web/avr-mcus.js from GCC's avr-mcus.def
scripts/build-arm-tools.py  builds binutils and GCC for arm-none-eabi as wasm
scripts/make-arm-assets.py  packs the wasm tools and the vendor sysroot into web/tools/arm
scripts/make-nrf52-index.py builds the Seeed index the page installs from
web/index.html, app.js      the page
web/page-index.js           the shipped index directories, and the fetch shim that maps them
web/page-tools.js           installs both toolchains behind the one exec seam
web/page-drivers.js         routes a tool name to the AVR or the ARM driver
web/exec.js                 the seam itself: request in, one driver's answer out
web/avr-driver.js           answers avr-g++/ar/size/ctags with wasm tools
web/arm-driver.js           answers arm-none-eabi-g++/ar/size and nrfutil the same way
web/avr-exec.js             installs that seam over the CLI's exec hook
web/arm-exec.js             the same, priming the ARM toolchain
web/nrfutil.js              adafruit-nrfutil's `dfu genpkg`, ported to JavaScript
web/avr-assets.js           one asset loader, shared by the page and the tests
web/arm-assets.js           the ARM one: six wasm modules and the sysroot archive
web/arm-tools.js            runs a wasm ARM tool: stage inputs, call main, read outputs
web/tool-common.js          the helpers both drivers need: flags, ELF, Intel HEX
web/avr-mcus.js             generated device to architecture and macro table
web/tools/avr/              the wasm AVR toolchain, with PROVENANCE.md
web/tools/arm/              the wasm ARM toolchain and sysroot, with PROVENANCE.md
web/indexes/avr/            the package index the page carries, with README.md
web/indexes/nrf52/          the Seeed index the page carries, with README.md
web/nodefs.js               filesystem shim: IndexedDB or memory, callback API
web/package.json            marks the page's JavaScript as ES modules for Node
web/arduino-cli.wasm        the build output
web/version.json            what the wasm was built from
ide/inpage/                 the in-page backend: channel pair, services, install
test/                       see Tests
```

`web/nodefs.js` implements the callback interface Go's `syscall` package calls
on `js` (`syscall/fs_js.go`), so storage is fully asynchronous. Every call from
JS into Go runs in a goroutine and reports back through a JS callback, because
blocking the JS stack would stall the event loop that `fetch` and the storage
callbacks need.

## Building and updating

```sh
python3 scripts/update.py                 # latest upstream release
python3 scripts/update.py --tag v1.6.0    # a specific release
```

Needs Go 1.24 or newer on `PATH`, or `GO=/path/to/go`. The script clones into
`build/arduino-cli`, copies `overlay/` over it, applies the build fixes, builds
for `js/wasm`, and writes `web/arduino-cli.wasm`, `web/wasm_exec.js` and
`web/version.json`.

The build output is not committed: `web/arduino-cli.wasm` alone is around 50 MB
and would grow the history on every upstream release. A fresh clone therefore
needs one build before the page will load, and the page says so instead of
failing with a parse error.

The upstream source is not edited by hand and there is no fork. Three things
have to be adjusted for a browser, and the script does each one every time:

1. `internal/arduino/utils/sync_others.go` is tagged for Unix only and imports
   `golang.org/x/sys/unix`. The build tag gains `&& !js`, which selects the
   no-op implementation.
2. `internal/arduino/cores/tools.go` picks tool downloads by
   `runtime.GOOS`/`GOARCH`. On `js` those match nothing, so both call sites are
   redirected to helpers that report a configurable host triple. Each
   replacement asserts it matched exactly once, so an upstream rename fails the
   build rather than silently reverting.
3. `github.com/cmaglie/pb` (imported through `internal/cli/feedback`) lacks
   `terminalWidth()` on `js`. The module is copied into the clone and given one
   build-tagged file; `go.mod` gains a `replace` for it.

Everything else is configuration at runtime, not a patch.

To rebuild without re-cloning, for example while iterating on `overlay/`:

```sh
python3 scripts/update.py --reuse --src build/arduino-cli --tag v1.6.0
```

`--tag` is required with `--reuse` unless the clone is exactly on a tag.

## Building the ARM toolchain

`arm-none-eabi-gcc` cannot run in a page, but its source is free, so the route
taken for AVR works here too: build the pieces to wasm and supply the target's
headers and libraries from the vendor package, which already ships them.

`scripts/build-arm-tools.py` does the whole build, with every stage on its own
and every download checked against a pinned SHA-256:

| stage | what it builds | source |
| --- | --- | --- |
| `binutils` | `gas`, `ld`, `objcopy`, `ar` for `arm-none-eabi` | binutils 2.42 |
| `hostlibs` | GMP 6.2.1, MPFR 4.1.0, MPC 1.2.1 for the wasm host | the GCC prerequisite list |
| `sources` | a GCC 9.2.0 tree, configured with the host libraries and `--target=arm-none-eabi` | gcc 9.2.0 |
| `install` | copies every finished program and its JS glue into `build/arm-wasm/out/` | — |

It needs an activated emsdk (`EMSDK` in the environment, or
`../.scratch/toolchain/emsdk`). Measured 2026-11-15 on this machine, 12 cores:
binutils took 1m57s, the host libraries 1m39s, and the compiler stage built both
front ends:

```
cc1.wasm      18880170 bytes   cc1.mjs      118726 bytes
cc1plus.wasm  20407202 bytes   cc1plus.mjs  119934 bytes
 as.wasm       1232833 bytes    ar.wasm       574153 bytes
 ld.wasm       1215635 bytes    objcopy.wasm  758535 bytes
```

The `.mjs` sizes match the AVR release's for the same Emscripten version.

The compiler version is not a preference: the platform declares
`arm-none-eabi-gcc 9-2019q4`, and the vendor tarball that index points at
reports `9.2.1 20191025 (release) [ARM/arm-9-branch revision 277599]`. GCC
9.2.0 is therefore what gets built, and the vendor's `9.2.1` library directory
is mounted where the wasm compiler looks for it. The sysroot comes out of that
same tarball (116,802,378 bytes, verified against a pinned SHA-256 and the MD5
the board index publishes); `scripts/make-arm-assets.py` cuts it down to the
header trees, the multilib the platform links against
(`thumb/v7e-m+fp/hard`) and the C/C++ runtime, and packs it as
`sysroot.tar.gz` — 1,463 files, 28,801,608 bytes of payload, 5,037,911 bytes
compressed.

`test/arm-tools.mjs` runs the binutils and checks the bytes rather than the exit
codes:

```
$ node test/arm-tools.mjs
ok   gas assembles a Thumb object [exit 0, 700 bytes]
ok   the object is ELF32 for ARM (machine 40) [machine 40, type 1]
ok   ld links an executable for ARM [machine 40, type 2, 4576 bytes]
ok   the entry point is Thumb [entry 0x1]
ok   the linked image holds the Thumb encodings of the source
ok   the literal pool holds 0x20001000
ok   objcopy writes Intel HEX that parses and ends at EOF
ok   the hex payload is the same image
ok   ar writes a GNU archive
ok   ld links from the archive ar wrote, giving the same image
ok   a bad -mcpu makes as exit non-zero
11/11 checks passed
```

The linked image is disassembled by hand: `01 48 01 21 01 60 fe e7` is
`ldr r0, [pc, #4]; movs r1, #1; str r1, [r0]; b .` and the literal that follows
is `0x20001000`. The archive check links from `libblink.a` instead of the
object, because an archive is only worth writing if `ld` can read it back. The
last check is the one that mattered most: the loader used to report `exit 0`
for an assembler that rejected its own flags, because Emscripten's `quit_`
throws and its status was being discarded.

`web/arm-driver.js` is what turns the platform's `g++` recipes into calls to
those programs, and it is the same shape as the AVR driver: it resolves the
multilib, stages the headers the source includes, preprocesses `.S` before
assembling, rewrites a linker script's `INCLUDE` to an absolute path, supplies
`size` and `ctags` itself, and logs every flag it cannot honour instead of
dropping it. That driver is what makes `test/nrf52.mjs` and
`test/page-nrf52.mjs` end in a linked image.


## Configuration

The page stores three URLs in `localStorage` and shows them in the Indexes
panel. Blank means "use the URL compiled into the CLI", which is Arduino's own.

| Field | Effect |
| --- | --- |
| package index URL | overrides the default index (`ARDUINO_DEFAULT_INDEX_URL`) |
| extra package index URLs | `board_manager.additional_urls` in the CLI settings |
| library index URL | overrides the library index (`ARDUINO_LIBRARIES_INDEX_URL`) |

Two environment variables are read by the wasm build itself, and the page sets
them from those fields:

- `ARDUINO_DEFAULT_INDEX_URL`
- `ARDUINO_LIBRARIES_INDEX_URL`

Signature verification is relaxed only for a library index that is not hosted
on `downloads.arduino.cc`, since a mirror cannot carry Arduino's signature.

Tool downloads are matched against a host triple. It defaults to `linux`/`amd64`
and can be set with `ARDUINO_TOOL_HOST_OS` and `ARDUINO_TOOL_HOST_ARCH`. The
browser cannot execute any tool it stores, so this only decides which archive
is fetched and kept.

## Hosting

`.github/workflows/deploy.yml` builds the CLI, runs the test suites, builds
the IDE frontend, and deploys `web/` -- both pages -- to GitHub Pages. The wasm
is built in CI, never committed.

It runs on push to `master`, on pull requests (build and test only), on demand
with an optional `tag` input, and weekly on a schedule, so a new upstream
release is picked up without anyone running anything. The tests are the gate: a
release that breaks the page fails the run and does not get deployed.

The IDE is built once per run. `--no-publish --reuse` clones (or reuses),
builds and collects; `build-ide-services.py` bundles the real services; then
`--reuse --publish-only` collects and publishes from that tree. The last step
must not call `build_app()` again: a second `theia build` failed in CI with
`ENOTEMPTY` on `lib/backend/native-webpack-plugin`. `--publish-only` checks the
built frontend by name and refuses if it is missing, and it never skips
`collect()`, so a publish cannot hide a stale collected tree.

The site is at <https://nemo-010.github.io/arduino-wasm/>. Pages is enabled for
the repository with the source set to GitHub Actions; a fork has to do that
once, in Settings → Pages.

GitHub Pages serves `.wasm` as `application/wasm`, so
`WebAssembly.instantiateStreaming` works there, and it sends
`access-control-allow-origin: *`. Both were checked against a Pages site with a
wasm file; no fallback is needed.

The IDE page is deployed with it, at
<https://nemo-010.github.io/arduino-wasm/ide/>. It is built output, so CI builds
it rather than committing it: the `build` job clones the arduino-ide tag, runs
the two build scripts, publishes into `web/ide/`, and uploads `web/` as one
artefact. That makes a push take about fifteen minutes longer on a cold cache
and pulls a 985 MB tree into `actions/cache` keyed on `scripts/build-ide.py`
and `ide/inpage/` -- those modules are copied into the clone, so a cache hit
would otherwise rebundle the previous in-page backend. The job also installs
`libsecret-1-dev`, `libx11-dev` and `libxkbfile-dev`: keytar's and
native-keymap's `binding.gyp` files call `pkg-config` for them and the runner
image does not ship them.

It is in the same job as the CLI deploy on purpose. Every deploy publishes the
whole of `web/`, so a separate IDE workflow would blank `/ide/` for the length
of each CLI deploy. The cost of that choice is the other direction: a broken
IDE build fails the run and nothing is deployed, which is how drift in the
pinned arduino-ide tree gets noticed instead of silently freezing the page.

What ships is what the page loads. `publish()` drops `.map` and `.gz` files,
which nothing requests -- devtools fetch maps; Pages compresses on the fly --
so the tree is 33 MB rather than 119 MB. Both stay in `build/ide-dist/` for
debugging. `test/ide-page.mjs` grades that stripped tree, not the built one.

Pull requests skip the IDE build and its four browser tests, which need a built
tree and Chrome. Run them from the working tree:

```sh
python3 scripts/build-ide.py --reuse
python3 scripts/build-ide-services.py
python3 scripts/serve.py --open           # then open /ide/
```

`serve.py` serves `web/` from its own root, so the IDE page is at `/ide/`.

`file://` works because the page's asset loader uses XHR, which `file://`
allows; `fetch` does not work there, so a browser needs
`--allow-file-access-from-files` when the page is opened from disk. That is the
path the tests measure. The `http://` path through `serve.py` is not measured
here, because this sandbox cannot bind a socket (`EACCES`); a browser fetch
would work there and XHR works on both.

## The Arduino IDE frontend

The page in `web/` is the CLI half. The IDE's own frontend is the Theia app from
`arduino/arduino-ide`; `scripts/build-ide.py` builds it with the target the app
ships, `electron`, and skips only the step that prepares an Electron *runtime*
this page never runs.

```sh
python3 scripts/build-ide.py            # clone 2.3.11 and build
python3 scripts/build-ide.py --reuse    # rebuild in the existing clone
python3 scripts/build-ide.py --tag 2.3.12
```

It installs with `--ignore-scripts` and then does the steps that upstream's
postinstall would have done, because those download binaries from
`downloads.arduino.cc`, which this build replaces with the wasm CLI anyway:

1. copies `i18n/*.json` to `src/node/resources/i18n` (upstream's `ncp` cannot
   create the parent directory);
2. copies `src/node/cli-protocol` to `lib/node/cli-protocol` (upstream's
   `postbuild`);
3. builds the `@theia/ffmpeg` addon, which the Theia CLI itself loads;
4. builds `drivelist`, `keytar`, `native-keymap` and `node-pty`;
5. fetches `@vscode/ripgrep`'s `rg` binary for the native webpack plugin from
   the pinned release asset, checking both the archive and the binary hashes.
   Upstream's postinstall asks `api.github.com` for the release and got 403 on a
   cold CI run; the asset itself needs no API call. The binary hash agrees with
   the copy upstream's postinstall fetched earlier, so the pin has two sources;
6. writes `src/node/resources/examples/PLACEHOLDER.txt`, because the webpack
   CopyPlugin globs that directory while ignoring `i18n/**` and aborts when
   nothing matches.

Measured on 2026-11-14, tag `2.3.11`, Node 24.11.1: exit 0, frontend
118,632,923 bytes, backend 75,289,689 bytes in `build/ide-dist/`. The frontend
is larger than a plain browser build because `ide/inpage/` is bundled into it.

#### Why the target stays `electron`

Theia's `--app-target=browser` looks like the obvious switch for a page, and it
is not usable here. Two measurements:

- the flag never reaches the build. `@theia/cli/lib/theia.js:101` parses it with
  `require("yargs/yargs")()` and no argv, so `appTarget` is `undefined` while the
  real command parse below uses the `yargs` singleton, which does read
  `process.argv`. Instrumented, the value was `appTarget= undefined argv= []`.
- the target it names cannot boot this app. Built as `browser`, the page stays
  on the splash forever with `Error: No matching bindings found for
  serviceIdentifier: Symbol(WindowServiceExt)`. `WindowServiceExt` is defined in
  `arduino-ide-extension/src/browser/theia/core/window-service-ext.ts` and bound
  only by `src/electron-browser/theia/core/electron-window-module.ts`, while five
  `src/browser/` contributions inject it (`check-for-updates`, `close`,
  `update-indexes`, `monaco-theming-service`, `workspace-service`).

So the app keeps its own target, and the one thing a page does not need is
removed: `@theia/application-manager`'s `prepare()` downloads Electron, reads
`node_modules/electron/dist/version` and installs a matching `libffmpeg.so` into
it. `scripts/ide-build.cjs` replaces that method with a no-op and then runs
upstream's CLI unchanged; `generate()`, `copy()` and the webpack pass are
upstream's. The wrapper exits 4 if the CLI and the app resolve different copies
of `@theia/application-manager` (a silent no-op otherwise), 3 if the method is
gone, and 2 with no app path.

The build is proven under CI's condition, not on a warm tree: with
`node_modules/electron/dist` moved aside and `os.tmpdir()/theia-cli` deleted,
`--reuse` exits 0 in 139 s and produces the same frontend bundle
(`md5 f1f3518dd501ab2c2de30671d19ce787`).

### The in-page backend

The build is a **frontend plus a Node backend**: the frontend asks for its
services over Theia RPC on `/services`, so a build normally needs a server
process beside it. `ide/inpage/` removes the server from the path without
reimplementing the protocol:

Theia's own `ChannelMultiplexer` and `RpcProxyFactory` are wired on both ends of
an in-memory channel pair, and the provider symbols the frontend resolves
(`ConnectionSource`, `ServiceConnectionProvider`) are bound to that pair. Three
files carry it:

- `inpage/channel.js` — a `ForwardingChannel` pair that delivers each frame
  from a microtask, so the two multiplexer state machines never re-enter each
  other; the connection source replays its channel to late listeners, because
  `ServiceConnectionProvider` is created lazily;
- `inpage/services.js` — the service targets: logger, keyboard, application,
  envs, workspace, stopwatch, task, remote-filesystem over an in-memory tree,
  sketches, and the Theia-core surface a browser cannot need (`i18n`, `debug`,
  `hostedPlugin`, `plugin-paths`, `cli-preferences`, `authentication-service`).
  They answer the shapes the frontend expects, because `undefined` surfaces as a
  `TypeError` inside Theia and hides which contract was missing;
- `inpage/inpage-backend-module.js` — `install(container)` rebinds the
  messaging symbols, wraps every target in a recorder that counts calls and
  names unimplemented methods, and stubs `window.electronTheiaCore` and
  `window.electronArduino` (a browser has no Electron preload).

The build inserts two lines into the generated entry, after
`container.load(messagingFrontendModule)` and before anything resolves a
service. The insertion asserts its match count, so an upstream change to that
entry stops the build. The ordering matters: Theia's default providers open a
WebSocket to a backend that does not exist here, and the OS and i18n preload
contributions await them, so installing after `preload()` stalls the boot
forever. With the in-page backend installed first, preload settles in
milliseconds.

Measured in headless Chrome 157 on 2026-11-14: the workbench reaches `ready`
1.708 s after frontend start, the toolbar renders `Select Board` and `No board
selected`, and 120 RPC calls have been answered. `node test/ide.mjs` asserts
those and that the splash is gone, and it fails those checks when the install
line is removed. It runs on a fresh browser profile and deletes it afterwards:
while it used a shared one, its sketch check passed on an AVR platform left in
that profile's IndexedDB, which a cold run cannot reproduce.

Opening a sketch and compiling it are graded against the shipped page in
`test/ide-page.mjs` instead. The collected build `test/ide.mjs` loads has no
boot script, so it cannot point arduino-cli at the shipped package index; with
`downloads.arduino.cc` unreachable the first-boot index download fails there and
the app opens no sketch. That is a property of that tree, not of the page that
ships.

Every RPC the boot makes has an implementation; `window.__inpageMissing` is
empty, and `test/ide.mjs` fails and names the method when one is not. Answering
a call and doing the work are different things, so the stubs are no longer the
answer for the services that can be real: seven paths —
`boards-service`, `library-service`, `core-service`, `config-service`,
`arduino-daemon`, `remote-filesystem`, `sketches-service` — are served by
arduino-ide's own compiled classes when the bundle is on the page, and fall back
to the stub method by method, with each fall-through recorded. The stubs remain
for what a browser genuinely has no backend for: there is no plugin host, no
debug adapter, and no serial monitor, so their empty answers are the true ones.
`upload` and `flash` still refuse with a message saying so.

One boot error is a real gap, not a stub: `A resource provider for
'user-storage:/user/keymaps.json' is not registered`, thrown from
`c.loadModel`, which leaves the keymaps editor without a model. The other two
are `Canceled: Canceled` from model disposal.

### The transport the IDE's own services need

The transport is what lets the extension's own services run in the page. It is
measured before anything above it is written.

`ide/inpage/cli-client.mjs` builds an object shaped like the gRPC client those
services call, out of the service definition the shipped build already contains:
it reads `commands_grpc_pb.js`, takes each method's Go name from the last segment
of its `path` (the definition's `originalName` is `undefined` and its type names
are empty strings), and sends it through the wasm bridge's `arduinoCLI.callBinary`.
Both directions are protobuf binary: the vendored `jspb` messages serialize with
`serializeBinary` and have no `fromObject`, and the desktop client speaks binary
too, so no JSON path is invented.

`overlay/wasm/main.go` gained `callBinary` beside `call` and a second `transport`
value beside the protojson one; every streaming handler is shared by both, so a
new RPC needs no bridge change for the unary case (dispatch is by reflection on
the real `ArduinoCoreServer`) and one entry in `streamHandlers` otherwise.

A gRPC stream carries the RPC's **response** message, never the bare inner
progress message. The bridge wraps each inner message in the response by finding
the field whose message type has the same full name, and fails loudly when no
field matches. Without that, a `PlatformInstall` stream delivers a
`TaskProgress`, and the generated client deserializes it as a
`PlatformInstallResponse` and throws inside `google-protobuf`.

Measured 2026-11-15 with `node test/ide-client.mjs` against the wasm built from
`v1.6.0`: 11 checks over unary calls (`Version`, `ConfigurationOpen`, `Create`,
`BoardListAll`, `BoardIdentify`, `LibraryList`) and streams (`Init`,
`PlatformInstall`, `UpdateLibrariesIndex`, `LibraryInstall`), 61 s including the
wasm start.

`node test/ide-services.mjs` goes further: it instantiates the extension's own
compiled classes from `lib/node`, with the only substitution being where they get
their client — a provider whose `client` resolves to this one instead of a gRPC
channel to a spawned daemon. `BoardsServiceImpl.getInstalledPlatforms()` returns
`testpkg:avr`, `getInstalledBoards()` returns `Test Board`, its `search` reaches
`boardSearch`; `LibraryServiceImpl` searches the fixture index, installs
`TestLib` through the real `install` path (which stops and starts board discovery
on the way), and lists it afterwards. Five checks.

### The bundle behind the page

`scripts/build-ide-services.py` bundles those same classes for the browser with
the IDE tree's own webpack, so no second bundler is added to the project. The
webpack config lives in `ide/inpage/browser/` and is not a reimplementation:
`entry.js` imports the extension's compiled modules, and the config answers each
Node built-in they import with one small module in that directory, all of them
forwarding to the page's single filesystem shim.

Three rules in that config are load-bearing.

The aliases are keyed by resolved absolute path as well as by bare id.
`core-client-provider.js` imports `./arduino-daemon-impl`, and
`resolve.alias` matches the request string, so the bare-id entry alone never
fires. The same holds for `./arduino-core-service-client` and `./exec-util`.

`node:` is stripped by `NormalModuleReplacementPlugin(/^node:/)` before the
aliases are consulted, because webpack treats the prefix as a URI scheme and
never resolves it.

The bundle is `umd` with `output.globalObject: "globalThis"`. Its two consumers
are `require()` in the Node tests and a script tag in the page; webpack's
inferred UMD root is `self`, which Node does not define.

The bundle is 5,513,828 bytes and the build refuses to write one under 1 MiB,
because a 5 KiB file is an empty shell, not a bundle.

#### `Buffer` goes to the modules that name it

The extension's `cli-error-parser` calls `Buffer.concat(content).toString('utf8')`
without importing anything. Installing `Buffer` on `globalThis` in the entry
point compiles and runs, and was measured to **blank the editor**: with the
global installed the page booted to `editors: 0` and a 36,692-character body;
without it, `editors: 2` and 49,232, three runs each. Some module in the
frontend takes a different branch when a global `Buffer` exists.

So the dependency is provided to the modules that name it, not to the world:
`new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] })`. Two tests guard
this from opposite directions. `test/ide-buffer.mjs` asserts the sources — no
global assignment in `entry.js`, the plugin present in the config, and, when the
bundle is on disk, one `var Buffer = __webpack_require__(…)["Buffer"]` binding
per module and no global assignment in it. `test/ide-page.mjs` grades the
consequence in a browser. The source test runs in CI; the browser test cannot.

#### The tool-instantiation seam

The same `process` object must satisfy two consumers that want opposite things.
Emscripten-generated loaders read
`process.versions.node` to decide whether they are in Node, and in a browser
that branch ends in `import("module")`, which throws
`Failed to resolve module specifier 'module'` — that is how every `avr-g++`
compile failed when the page's `process` advertised a Node version. The IDE
bundle needs `versions.node` present, because `es6-shim` chooses its
`Map`/`Set` iterator fallbacks by it, and Node's own shim reads it too.

The fix is at the boundary rather than in the environment: `createToolInstance()`
in `web/tool-common.js` hides `process.versions` for the duration of one loader
instantiation and restores it in a `finally`. Both instantiation sites use it
(`web/avr-driver.js`, `web/arm-tools.js`). `test/tool-common.mjs` asserts the
property in Node — the version absent during the factory call, present
afterwards as the same object, absent-not-falsy, and restored when the factory
throws — because Node cannot reproduce the browser's failure.

#### The top bar

The Electron app draws its File/Edit/Sketch/Tools/Help menu in the native
window through `window.electronArduino.setMenu`, which this page has to stub
with a no-op, so the browser initially rendered no menu bar at all. The overlay
binds Theia's own browser menu factory in the container and adds its menu bar
to the shell's top panel. The factory and shell must not be resolved while the
frontend is still starting up: doing so stopped the boot sketch from opening
(measured, with a control build that left the hook out). The setup therefore
runs at the app's `ready` state, and the bar is filled once the contributions
have populated the menu model. Pressing Alt toggles the bar, the way Windows
reveals its hidden native menu. `test/ide-page.mjs` asserts both the six menus
and the Alt toggle.

#### What the page actually runs

`node test/ide-page.mjs` boots `web/ide/index.html` in headless Chrome over
`file://`, waits for the workbench, then drives the page's own service surface
(`window.__inpageTargets`, the published RPC proxies) through the sequence a user
performs: install `arduino:avr` from the shipped index, create a sketch, compile
it. It asserts 16 things, including that the window titles the sketch, that
Monaco displays the sketch's source, that the bundle is the real one
(`window.__inpageReal === 'bundled'`), that no service method went unanswered,
and that the compile ends with the CLI's own section sizes — measured
`text 2044 of 32256`, `data 197 of 2048`.

Measured 2026-11-16 on 12 cores: 165 s end to end, starting from an empty Chrome
profile. CI builds the IDE tree just before it runs this test, so it runs there
too; locally it needs `python3 scripts/build-ide.py` and
`python3 scripts/build-ide-services.py` first. It exits 2 with those commands
printed when the tree is missing, and it writes `build/ide-page.png`. The same
test grades the deployed page with
`NETWORK=1 node test/ide-page.mjs https://nemo-010.github.io/arduino-wasm/ide/`,
writing `build/ide-live.png` instead.

The published page loads `wasm_exec.js` and `ide-boot.js` and nothing else:
`ide-boot.js` waits for the CLI and then injects `services.js` followed by
Theia's `bundle.js`. Both bundles read `process.env` while their modules are
being defined, and the nodefs shim that provides it is installed by an async
import chain. As classic script tags they raced that chain: `file://` was fast
enough, but on Pages they ran first and died on
`Cannot read properties of undefined (reading 'NODE_DEBUG')`, leaving a shell
with no services. The live command above is what caught it.

Still stubbed, and named as such: the serial monitor (a Proxy that throws by
name), the plugin host, and the debug adapter, because a browser has no backend
for them at all; `upload` and `flash` refuse by name; and the `nrfjprog` tool
archive the page carries is a dummy, since the tools it would install are not
reachable from here.

Running the Electron-shaped server is still possible and still the reference
path:

```sh
curl -sSL -o cli.tgz https://github.com/arduino/arduino-cli/releases/download/v1.6.0/arduino-cli_1.6.0_Linux_64bit.tar.gz
mkdir -p build/cli-bin && tar xzf cli.tgz -C build/cli-bin arduino-cli
cp build/cli-bin/arduino-cli build/ide-dist/backend/resources/
node build/ide-dist/backend/main.js --port=3000 --hostname=127.0.0.1
```

That backend starts `resources/arduino-cli daemon` and speaks gRPC to it,
exactly as the Electron app does, so it needs a listening socket (`python3` and
`node` both fail to bind here with `EACCES`). The in-page backend is the route
that needs no socket, and the page is served from the filesystem while testing.

## Serving

```sh
python3 scripts/serve.py            # http://127.0.0.1:8000/
python3 scripts/serve.py --open
```

`WebAssembly.instantiateStreaming` refuses a response whose content type is not
`application/wasm`, and Python's `mimetypes` does not know the extension
everywhere. `serve.py` sets it, and sends `Cache-Control: no-store` so a rebuild
is picked up on reload.

Any static server works if it does the same. The page must be served over
`http://localhost` or `https://`: WebSerial is unavailable on plain `http://`
for any other host.

## Tests

```sh
node test/run.mjs            # the CLI, through the same sequence the IDE uses
node test/page.mjs           # the page itself, headless
node test/avr.mjs            # install the AVR core, compile blink, check the hex
node test/page-compile.mjs   # the same compile through the page's own controls
node test/page-browser.mjs   # that compile in Chrome, over file://, 79 s
node test/nrfutil.mjs        # the DFU package writer, against goldens
node test/page-nrf52.mjs     # install the Seeed core, compile blink, check the zip
NETWORK=1 node test/live.mjs # the deployed page, in Chrome, over HTTP
python3 test/serve_test.py   # the static server's headers
python3 test/gateway_test.py # the CORS gateway, over a socket pair
node test/gateway.mjs        # the gateway URL rewrite in Go's transport
node test/ide.mjs            # the real IDE frontend, headless Chrome, needs a build
node test/ide-buffer.mjs     # how the services bundle gets Buffer
node test/ide-client.mjs     # the IDE's gRPC client, needs a built IDE tree
node test/ide-services.mjs   # the IDE's own backend classes, same precondition
node test/ide-page.mjs       # the IDE's own UI in Chrome, compiles a sketch
NETWORK=1 node test/network.mjs   # a real index over TLS, opt-in
NETWORK=1 node test/nrf52.mjs     # install a real core, compile blink, opt-in
NETWORK=1 node test/board-glyph.mjs [url]  # simulate ESP32-C6 setup + upload
```

`test/page-browser.mjs` and `test/ide-page.mjs` both run in CI: the workflow
finds the runner's Chrome and hands both tests its path. The first is the one
that grades the CLI page in a browser, so it is the only thing that would notice
if `createToolInstance()` went away — measured, by bypassing the helper and
watching the compile fail while every Node test stayed green. Both also run
locally; the runner's Chrome is not the one a developer uses, so their versions
are printed in the test output.

`test/arm-tools.mjs` is not in that list because it needs `build/arm-wasm/out/`,
which a fresh clone does not have: the tools are built by the script and
gitignored. `test/nrf52.mjs` needs the network.

`test/board-glyph.mjs` simulates a user adding Espressif's index, installing
`esp32:esp32`, selecting `esp32:esp32:esp32c6` (the ESP32-C6 board the Glyph
hardware uses; neither vendor repo has a Glyph-specific id), and uploading
Blink, with a dummy WebUSB device attached. It reports each step's outcome
instead of claiming the board flashed. Measured 2026-11-17 against the deployed
page: the URL is written into `arduino-cli.yaml`, `updateIndex` returns ok, but
`package_esp32_index.json` never appears in the data directory and the install
fails with `package esp32 not found`, so compile and upload are not reached and
the dummy USB sees zero calls. That is the concrete blocker for this board, not
a success. WebUSB is also not what Arduino's upload path uses: it goes through
the CLI's native esptool and a serial port, neither of which this page can run.

The three IDE tests that need a built tree all grade `web/arduino-cli.wasm`, the
file the page ships. A copy in `/tmp` once made `test/ide-client.mjs` grade a wasm
built before the bridge carried gRPC status codes, and the failure read as a
product defect for two runs. `ARDUINO_WASM_BIN` still overrides it; the default
does not. A missing input is a named precondition: each prints the path, the
command that builds it, and exits 2 rather than 1.

`test/ide-client.mjs` and `test/ide-services.mjs` need a built IDE tree under
`build/arduino-ide/`. They drive arduino-ide's own generated gRPC client and its
own compiled service classes, and neither exists anywhere else: the extension is
not published to npm, and its task classes are TypeScript compiled by
`scripts/build-ide.py`. CI does not build that tree because it means a yarn
install of the whole monorepo, so these two run where the tree exists. This is a
missing precondition, not a flake, and it is why the workflow does not call
them.

`test/run.mjs` drives the wasm CLI directly: init, index update, platform
search, platform install (with its tools), library install, board
identification, and assertions on the resulting files. It also writes 32 MB in
8 KB chunks and fails if that takes more than ten seconds, which is the guard
against a write path that copies the whole file on every write. The fixture
index points
at `test/fixtures`, served through an injected `fetch`, because this sandbox
cannot bind a socket.

`test/page.mjs` imports the real `web/app.js` with a minimal DOM, the real wasm
and the real filesystem shim, then presses the buttons: update indexes, search
and install a core, search and install a library, list what is installed,
identify a board from a fake WebSerial port, and save index settings.

`test/avr.mjs` compiles a sketch for `arduino:avr:uno` and reads what came out:
the CLI's own size line, the ELF, the 25 core objects, the EEPROM image, and a
152-record Intel HEX that starts at the AVR reset vector. It installs the core
from the same `web/indexes/avr/` the page ships, through an injected `fetch`, so
the test and the page install the same bytes. It also asserts that no command
reached a tool the page does not implement.

`test/page-compile.mjs` does the same compile through `web/app.js`'s own
buttons: install the core from the shipped index, compile the sketch in the
textarea, and check the size line, the seconds, and the `.hex` the download link
carries. The page's index shim runs with a disk `read` instead of a socket, so
the mapping is exercised; the XHR transport itself is the one part a Node test
cannot reach. Removing the page's toolchain install makes it fail with
`pipe: not implemented on js` — planted and measured.

`test/arm-tools.mjs` runs the wasm ARM binutils — assemble, link, `objcopy` to
binary and Intel HEX, `ar` and a second link from the archive — and checks the
linked bytes against the Thumb encodings the source must produce. It exits 2
when `build/arm-wasm/out/` is absent, because those tools are built locally and
not committed; CI does not build them.

`test/nrfutil.mjs` checks the JavaScript port of `adafruit-nrfutil dfu genpkg`
against committed goldens — entry names, the `.dat` layout, the CRC, the
manifest — and, when `NRFUTIL_BIN` names a real `adafruit-nrfutil`, generates the
same package with both and compares entry by entry. The goldens were produced by
the real tool, so the test does not merely agree with itself.

`test/nrf52.mjs` is the whole pipeline for the XIAO nRF52840 through the wasm
CLI: it installs the Seeed platform from its real index, compiles blink, and
checks the ELF, the Intel HEX, the reset vector it finds by searching for the
ELF's own entry point, the CLI's size line, and the DFU zip. With `NRFUTIL_BIN`
set it also regenerates that zip with the real tool and compares all three
entries. `NRF52_DUMP=<dir>` writes the build's artefacts out for inspection.

`test/page-nrf52.mjs` is the same compile through `web/app.js` and the page's own
buttons, with the page's shipped index and the `web/tools/arm/` assets: it
presses **Install Seeeduino:nrf52**, compiles, and checks the size line, the
`.hex`, and the `.zip` contents. That is the test that proves the ARM pipeline
works from the committed assets rather than from `build/arm-wasm/out/`. It does
not press **Update indexes** first, because a first visit has none: installing a
core refreshes the package indexes itself, and removing that refresh from
`installCoreNamed` fails this test with `package Seeeduino not found`.

`test/live.mjs` is the only test that uses a real browser against a real origin.
Every other page test fakes the DOM and reaches the page's files through a
stubbed XHR, so none of them can say whether the page served by Pages loads its
own assets and its shipped indexes. This one loads the deployed URL in headless
Chrome, presses **Install Seeeduino:nrf52** once, compiles, and asserts the
flash line, the `.hex` download, no uncaught exception, and that the only failed
request is the library index on `downloads.arduino.cc`, which this page cannot
read. Its cause was not established: the host answers this sandbox with `403`
from Cloudflare before any header is sent, so whether a browser elsewhere is
refused by CORS or by the host's IP reputation is unmeasured, and Chrome reports
both as `net::ERR_FAILED`. It needs the Electrosphere, so it runs only with
`NETWORK=1` and exits 2 without it:
`NETWORK=1 node test/live.mjs [url]`. It starts from a fresh Chrome profile
every run, because the platform lives in IndexedDB and a profile that kept it
would skip the first run. Against the deployed page on 2026-11-15 that took
**909 s end to end**: the install of the Seeed core, then a compile the page
reported as 270.2 s producing `26816 bytes of flash`. Nothing is cached between
runs, so that is what a first visit costs in this browser on this machine.

`test/zip.mjs` is the zip reader both of those use; it reads the central
directory and asserts the compression method, so a writer that lies about its
method fails the test rather than the flasher.

`test/ide.mjs` boots the built IDE frontend in headless Chrome over a CDP pipe
and asserts what the app itself reports: the shell has body text, the title
names the IDE, the in-page backend is installed, RPC calls were answered, every
RPC the boot made has an implementation, the toolbar says `Select Board`, a
`.ino` is open in the editor, and the workbench logged the transition to
`ready`. `test/cdp.mjs` is the driver: it reads
commands on fd 3 and replies on fd 4, never rejects (a dead renderer still
yields its console), and enables `Inspector` so a renderer crash is recorded.
The test exits 2 when Chrome or `build/ide-dist/frontend/index.html` is absent.
It fails six checks when the in-page install line is removed; that was planted
and measured. Unregistering one service target fails the implementation check
with the three methods named — `/services/library-service search, search, list`
— and that was planted and measured too.

`test/serve_test.py` drives the real handler over a socket pair and checks the
wasm content type and the no-store header.

`test/gateway_test.py` drives the gateway the same way, with the upstream fetch
replaced by a recorder: it checks a 200 with the CORS header, a 206 that keeps
`Content-Range`, chunked framing when the origin sends no length, a passed
through 403, a 400 for bad base64, a 403 for an `http://` target, a 502 for a
transport failure, the preflight, and HEAD.

`test/gateway.mjs` runs two wasm instances: one with `ARDUINO_CORS_GATEWAY` set
and one without. Its fetch refuses nothing, but records every URL, and the
gateway phase asserts that every request — index, library index, and the
archive the downloader fetches with its own client — arrives gateway-shaped and
decodes back to the real URL, while the second instance shows requests going
direct when the variable is absent. It fails when the transport wrapper is
removed: that was planted and measured, 6 failed checks.

None of these but `test/ide.mjs` run a browser. CORS against the real origins,
WebSerial against real hardware, IndexedDB persistence across reloads, the
browser's own `XMLHttpRequest` over `file://`, and layout beyond the checks
above are not covered here. The last one is the gap that matters most for the
compile path: the Node test replaces the browser's XHR with a disk read through
the same `createIndexFetch` code the page runs, which proves the mapping but not
the transport.

The fixture index and its archives are generated, not committed:
`test/fixtures.py` writes them, and the first test run does it automatically.
The tests need Node and `python3` on `PATH`.

## Storage

One IndexedDB database (`arduino-wasm`) with one store keyed by absolute path.
The layout inside it is the layout the CLI expects:

```
/home/arduino/.arduino15/            data dir: package indexes, packages/, staging/
/home/arduino/Arduino/libraries/     user libraries
/tmp                                 scratch space for downloads
```

Erase stored files deletes the database and reloads.

## Notes

**`downloads.arduino.cc` is unreachable from the sandbox this was built in**,
which returns 403 with a Cloudflare block page even for the native CLI binary.
That is an egress block on this machine, not a browser restriction: a header
echo of the index URL reports `access-control-allow-origin: *`, so a browser
should be able to fetch it. That claim is unverified here; the tests use
third-party indexes and local fixtures instead.

**A platform can report an older `latestVersion` than the index lists.** For
`esp32`, `PlatformSearch` says `2.0.9` while the index's newest release is
`3.3.12`. That is the CLI's own compatibility filter: a release counts as
available only when every tool it depends on has a matching release for the host
triple. esp32 3.x needs `arduino:dfu-util`, which lives in the official Arduino
index, and that index cannot be fetched here. The official `arduino-cli` 1.6.0
binary, run over the same index file, prints the same `2.0.9`.
