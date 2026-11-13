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

## What does not work

**Compile and upload.** The builder runs the platform's toolchain as a child
process (`internal/arduino/builder/builder.go:541`, `command.Start()`). A
WebAssembly module has no `fork`/`exec`. Measured with a ten-line probe that
calls `exec.Command("/bin/true").Run()` under `GOOS=js`:

```
*fs.PathError: fork/exec /bin/true: not implemented on js
```

That is a property of the platform, not of this build. Uploading has the same
shape: `avrdude` and friends are child processes too. WebSerial can open the
port, but there is no compiler to produce the bytes to send.

The board run is reproduced by `NETWORK=1 node test/nrf52.mjs`. It adds Seeed's
board URL, installs `Seeeduino:nrf52@1.1.9`, writes blink and compiles it for
the XIAO nRF52840. Measured 2026-11-13 it took 74 s and stopped at the same
wall:

```
compile failed: Compile: pipe: not implemented on js
```

Everything before that wall worked, against the real servers:

- the 290,172 byte index fetched over TLS and parsed into 14 releases of
  `Seeeduino:nrf52`, five of them boards, including "Seeed XIAO nRF52840";
- the platform and all three tool dependencies installed into the wasm
  filesystem: 2,451 core files and 13,905 tool files;
- the ARM compiler now on disk is a 1,153,656 byte x86-64 ELF, `e_machine 62`.

That last line decides what comes next. A vendor toolchain has no source, so it
cannot be built to wasm; running it needs a Linux ELF emulator such as gex. The
binary the installer produced is exactly the shape gex accepts. Until that runs,
nothing in this project can produce a `.hex` or a `.uf2`.

The script exits 0 (compiled), 2 (a download was refused), 3 (reached the
toolchain and could not start it) or 1 (anything else), so the outcome is
checkable without reading prose.

**Board URLs without CORS headers.** `files.seeedstudio.com` serves
`package_seeeduino_boards_index.json` with no `access-control-allow-origin`:
measured 2026-11-13, HTTP 200, header absent. A page cannot read that response,
and the harness above passes only because Node's fetch does not enforce CORS.
GitHub-hosted indices (esp32, Adafruit, and the toolchain archives the Seeed
package points at) do send `*`. A core whose index is not CORS-enabled needs a
proxy or a mirror you control before the page can install it.

**Port discovery.** The IDE gets serial ports from `serial-discovery` and
`mdns-discovery`, which are separate binaries run as plugins. They cannot run
in a tab, so `Init` reports them as missing. That message is expected. The page
supplies the vendor and product ids from WebSerial instead, which is enough for
`BoardIdentify`.

## Files

```
overlay/                    files copied over the upstream clone
  wasm/main.go              entry point: the JS bridge
  internal/…                js-specific replacements (locales, sync, tool host)
scripts/update.py           clone + patch + build; the only update mechanism
scripts/serve.py            static server, correct wasm content type
scripts/build-ide.py        builds the arduino-ide frontend for the browser
web/index.html, app.js      the page
web/nodefs.js               filesystem shim: IndexedDB or memory, callback API
web/package.json            marks the page's JavaScript as ES modules for Node
web/arduino-cli.wasm        the build output
web/version.json            what the wasm was built from
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

`.github/workflows/deploy.yml` builds the CLI, runs the three test suites, and
deploys `web/` to GitHub Pages. The wasm is built in CI, never committed.

It runs on push to `master`, on pull requests (build and test only), on demand
with an optional `tag` input, and weekly on a schedule, so a new upstream
release is picked up without anyone running anything. The tests are the gate: a
release that breaks the page fails the run and does not get deployed.

The site is at <https://nemo-010.github.io/arduino-wasm/>. Pages is enabled for
the repository with the source set to GitHub Actions; a fork has to do that
once, in Settings → Pages.

GitHub Pages serves `.wasm` as `application/wasm`, so
`WebAssembly.instantiateStreaming` works there, and it sends
`access-control-allow-origin: *`. Both were checked against a Pages site with a
wasm file; no fallback is needed.

## The Arduino IDE frontend

The page in `web/` is the CLI half. The IDE's own frontend is the Theia app from
`arduino/arduino-ide`; `scripts/build-ide.py` builds it for the browser target.

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
5. runs `@vscode/ripgrep`'s postinstall for the binary the native webpack
   plugin copies;
6. writes `src/node/resources/examples/PLACEHOLDER.txt`, because the webpack
   CopyPlugin globs that directory while ignoring `i18n/**` and aborts when
   nothing matches.

Measured on 2026-11-13, tag `2.3.11`, Node 24.11.1: exit 0, frontend 64,821,467
bytes, backend 34,375,912 bytes in `build/ide-dist/`.

`--app-target=browser` is Theia's target name. It still emits a **Node
backend**: the frontend talks to it over Theia RPC on `/services`, so a browser
build is a frontend plus a server process, not a static site. To run it:

```sh
curl -sSL -o cli.tgz https://github.com/arduino/arduino-cli/releases/download/v1.6.0/arduino-cli_1.6.0_Linux_64bit.tar.gz
mkdir -p build/cli-bin && tar xzf cli.tgz -C build/cli-bin arduino-cli
cp build/cli-bin/arduino-cli build/ide-dist/backend/resources/
node build/ide-dist/backend/main.js --port=3000 --hostname=127.0.0.1
```

Then open `http://127.0.0.1:3000/`. The backend starts `resources/arduino-cli
daemon` and speaks gRPC to it, exactly as the Electron app does. That daemon
needs a listening socket, so the wasm CLI cannot serve it: the wasm CLI is
driven through `arduinoCLI.call` by this project's page instead.

This was verified as far as this sandbox allows: the backend bundle boots,
resolves the CLI, and stops at `listen EACCES: permission denied
127.0.0.1:3111`. No process here may bind a socket (`python3` and `node` both
fail), so the IDE server cannot be started and the rendered UI is unverified.

Making it static is a separate job: it means replacing the backend RPC with
in-page implementations of the `common/protocol` services, backed by the wasm
CLI and `web/nodefs.js`. Nothing in the frontend bundle prevents that; the
handlers are simply not written yet.

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
python3 test/serve_test.py   # the static server's headers
NETWORK=1 node test/network.mjs   # a real index over TLS, opt-in
NETWORK=1 node test/nrf52.mjs     # install a real core, compile blink, opt-in
```

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

`test/serve_test.py` drives the real handler over a socket pair and checks the
wasm content type and the no-store header.

None of these run a browser. CORS, WebSerial against real hardware, IndexedDB
persistence across reloads, and layout are not covered here; there is no browser
in the environment these tests were written in.

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
