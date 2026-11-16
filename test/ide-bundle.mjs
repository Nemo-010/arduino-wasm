// Runs the browser bundle of arduino-ide's backend services in Node.
//
// `ide/inpage/browser/` is the page's side of the IDE: the extension's own
// classes with a filesystem, an environment and a client that exist in a
// browser. This test loads exactly the artefact the page loads -- the webpack
// output -- with the same globals `web/app.js` installs, and asks it for real
// answers from the wasm CLI.
//
// It is deliberately separate from `test/ide-services.mjs`: that one runs the
// classes unbundled, this one runs the bundle, so a missing alias or a Node
// built-in that leaked into the bundle shows up here and nowhere else.
//
// A compile is not driven here. The fixture platform in `test/fixtures/` is a
// zip with no toolchain in it, so a compile through this bundle would fail for
// a reason that says nothing about the bundle. The page's compile path is
// `test/page-compile.mjs` and `test/page-nrf52.mjs`, which run against the real
// AVR and ARM toolchains the page ships.

import { createRequire } from "node:module";
import { startCLI } from "./harness.mjs";
import { fixtureFetch, FIXTURE_ORIGIN } from "./fixture-fetch.mjs";

const realProcess = process;
const bundle = realProcess.env.IDE_SERVICES_BUNDLE || "/workspace/arduino-wasm/build/ide-services/services.js";
const require = createRequire(import.meta.url);

let failures = 0;
function check(condition, message, detail) {
  if (condition) {
    console.log("  ok  " + message);
  } else {
    failures += 1;
    console.log("  FAIL " + message);
    if (detail !== undefined) console.log("       " + detail);
  }
}

// An await on a promise that never settles ends the process with exit code 0
// and no output, which reads as a pass. The Go runtime holds no Node handle, so
// a keepalive is what keeps the loop alive, and the deadline is what turns a
// hang into a failure.
const keepalive = setInterval(() => {}, 1000);
function deadline(promise, label, ms) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + " did not settle within " + ms + " ms")), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function main() {
  const cli = await startCLI({
    wasm: realProcess.env.ARDUINO_WASM_BIN || "/workspace/arduino-wasm/web/arduino-cli.wasm",
    fetch: fixtureFetch(),
    env: {
      ARDUINO_DEFAULT_INDEX_URL: FIXTURE_ORIGIN + "/package_fixture_index.json",
      ARDUINO_LIBRARIES_INDEX_URL: FIXTURE_ORIGIN + "/library_index.json",
      ARDUINO_TOOL_HOST_OS: "linux",
      ARDUINO_TOOL_HOST_ARCH: "amd64",
    },
  });

  // The page installs these before anything else runs, and the bundle's own
  // modules read them lazily for that reason.
  globalThis.fs = cli.shim.fs;
  globalThis.path = cli.shim.path;
  globalThis.process = cli.shim.process;

  for (const dir of ["/tmp", "/home/arduino/Arduino", "/home/arduino/.arduino15"]) {
    await new Promise((resolve, reject) =>
      cli.shim.fs.mkdir(dir, { recursive: true }, (error) => (error ? reject(error) : resolve())),
    );
  }

  const configModule = require(bundle);
  check(typeof configModule.createIdeServices === "function", "the bundle exports createIdeServices");
  if (typeof configModule.createIdeServices !== "function") return 1;

  const output = [];
  const services = await configModule.createIdeServices({
    log: (level, message) => {
      if (level === "error") console.log("  log error: " + message);
    },
    appendToOutput: (message) => output.push(message),
  });
  const { boardsService, libraryService, clientProvider, configService, notifications } = services.container;

  const client = await deadline(clientProvider.client, "CoreClientProvider.client", 180000);
  // The provider resolves with the jspb `Instance` message, the way the desktop
  // app's daemon client does; every service passes it straight to
  // `req.setInstance(...)`.
  const instanceId = client.instance.getId();
  check(instanceId > 0, "CoreClientProvider created the CLI instance", instanceId);
  if (!instanceId) return 1;

  // The configuration the CLI was started with has to be absolute; the CLI's
  // own defaults for GOOS=js are only right because the js build takes the
  // linux branch.
  const configuration = await deadline(configService.getConfiguration(), "configService.getConfiguration()", 60000);
  const { config } = configuration;
  check(config.dataDirUri === "file:///home/arduino/.arduino15", "the data directory is absolute", config.dataDirUri);
  check(config.sketchDirUri === "file:///home/arduino/Arduino", "the sketchbook is absolute", config.sketchDirUri);

  // The Board Manager's install button, the way the UI calls it.
  const item = {
    id: "testpkg:avr",
    name: "Test AVR Boards",
    summary: "fixture platform",
    author: "fixtures",
    availableVersions: ["1.0.0"],
    installedVersion: "",
  };
  await deadline(
    boardsService.install({ item, version: "1.0.0", skipPostInstall: true }),
    "boardsService.install()",
    180000,
  );
  check(true, "BoardsServiceImpl.install() streamed a platform install to the CLI");

  const platforms = await boardsService.getInstalledPlatforms();
  check(
    platforms.some((platform) => platform.id === "testpkg:avr"),
    "the installed platform is listed through the service",
    JSON.stringify(platforms.map((platform) => platform.id)),
  );

  const installedBoards = await boardsService.getInstalledBoards();
  check(
    installedBoards.some((board) => board.name === "Test Board"),
    "getInstalledBoards lists the fixture board",
    JSON.stringify(installedBoards.map((board) => board.name)),
  );

  const found = await boardsService.search({ query: "Test" });
  check(found.length > 0, "board search reaches the CLI through the bundled service", JSON.stringify(found).slice(0, 120));

  const libraries = await libraryService.search({ query: "TestLib" });
  const libraryItem = libraries.find((library) => library.name === "TestLib");
  check(Boolean(libraryItem), "library search works in the bundle", JSON.stringify(libraries).slice(0, 120));

  if (libraryItem) {
    await deadline(libraryService.install({ item: libraryItem }), "libraryService.install()", 180000);
    const listed = await libraryService.list({});
    check(
      listed.some((library) => library.name === "TestLib"),
      "the library manager lists the installed library",
      JSON.stringify(listed.map((library) => library.name)),
    );
  }

  console.log("  notifications the page must show: " + JSON.stringify([...new Set(notifications.map((n) => n.name))]));
  console.log("  output lines the page must append: " + output.length);
  console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " checks failed");
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    clearInterval(keepalive);
    realProcess.exitCode = code;
  })
  .catch((error) => {
    clearInterval(keepalive);
    console.error(error && error.stack ? error.stack : String(error));
    realProcess.exitCode = 1;
  });
