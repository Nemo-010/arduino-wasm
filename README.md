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

Measured on 2026-11-14, tag `2.3.11`, Node 24.11.1: exit 0, frontend
118,632,923 bytes, backend 75,289,689 bytes in `build/ide-dist/`. The frontend
is larger than a plain browser build because `ide/inpage/` is bundled into it.

### The in-page backend

`--app-target=browser` is Theia's target name. It still emits a **Node
backend**: the frontend asks for its services over Theia RPC on `/services`, so
a browser build is normally a frontend plus a server process. `ide/inpage/`
removes the server from the path without reimplementing the protocol:

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
  and sketches. They answer the shapes the frontend expects, because
  `undefined` surfaces as a `TypeError` inside Theia and hides which contract
  was missing;
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
1.745 s after frontend start, the toolbar renders `Select Board` and `No board
selected`, a `sketch_20261114l.ino` is open in a Monaco editor with
`void setup() {}`, and 110 RPC calls have been answered. `node test/ide.mjs`
asserts those, and it fails six checks when the install line is removed.

It is a shell, not a working IDE. The recorder lists the services that no
target implements yet — `boards-service`, `config-service`, `example-service`,
`library-service`, `cli-preferences`, `arduino-daemon`,
`arduino-firmware-uploader`, `authentication-service`, `plugin-paths`, `debug`,
`hostedPlugin` — and `window.__inpageMissing` reports each one it is asked for.
Those are the work list: each becomes a call into `arduinoCLI.call`, sharing the
wasm CLI's storage instead of the in-memory tree.

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
python3 test/serve_test.py   # the static server's headers
python3 test/gateway_test.py # the CORS gateway, over a socket pair
node test/gateway.mjs        # the gateway URL rewrite in Go's transport
node test/ide.mjs            # the real IDE frontend, headless Chrome, needs a build
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

`test/ide.mjs` boots the built IDE frontend in headless Chrome over a CDP pipe
and asserts what the app itself reports: the shell has body text, the title
names the IDE, the in-page backend is installed, RPC calls were answered, the
toolbar says `Select Board`, a `.ino` is open in the editor, and the workbench
logged the transition to `ready`. `test/cdp.mjs` is the driver: it reads
commands on fd 3 and replies on fd 4, never rejects (a dead renderer still
yields its console), and enables `Inspector` so a renderer crash is recorded.
The test exits 2 when Chrome or `build/ide-dist/frontend/index.html` is absent.
It fails six checks when the in-page install line is removed; that was planted
and measured.

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
WebSerial against real hardware, IndexedDB persistence across reloads, and
layout beyond the checks above are not covered here.

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
