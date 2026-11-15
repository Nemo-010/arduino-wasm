// Runs arduino-ide's own backend service implementations against the wasm CLI.
//
// This is the point of the exercise: not a reimplementation of the IDE's services,
// and not a stub that answers the frontend with made-up shapes. The compiled
// classes from arduino-ide's `lib/node` are instantiated as they are; the only
// substitution is where their shared client comes from -- a provider whose
// `client` resolves to our protobuf client instead of a gRPC channel to a
// spawned daemon.
//
// Nothing here talks to a browser: if the services cannot work in Node, a bundle
// would only be hiding the problem.

import { createRequire } from "node:module";
import { startCLI } from "./harness.mjs";
import { fixtureFetch, FIXTURE_ORIGIN } from "./fixture-fetch.mjs";
import { createArduinoCoreClient, CORE_SERVICE_NAME } from "../ide/inpage/cli-client.mjs";

const realProcess = process;
const extension = "/workspace/arduino-wasm/build/arduino-ide/arduino-ide-extension/lib";
const require = createRequire(extension + "/");
// inversify's decorators call Reflect.hasOwnMetadata, which only exists once
// reflect-metadata has run. The IDE's own entry points load it first.
require("reflect-metadata");

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("  ok  " + message);
}

async function main() {
  // Before startCLI: the page's filesystem shim replaces the global `process`, and
  // the extension's own modules read process.env while they load.
  const grpc = require("./node/cli-protocol/cc/arduino/cli/commands/v1/commands_grpc_pb.js");
  const commands = require("./node/cli-protocol/cc/arduino/cli/commands/v1/commands_pb.js");
  const settingsPb = require("./node/cli-protocol/cc/arduino/cli/commands/v1/settings_pb.js");
  const { BoardsServiceImpl } = require("./node/boards-service-impl.js");
  const { LibraryServiceImpl } = require("./node/library-service-impl.js");

  const cli = await startCLI({
    wasm: realProcess.env.ARDUINO_WASM_BIN || "/tmp/cli-test.wasm",
    fetch: fixtureFetch(),
    env: {
      ARDUINO_DEFAULT_INDEX_URL: FIXTURE_ORIGIN + "/package_fixture_index.json",
      ARDUINO_LIBRARIES_INDEX_URL: FIXTURE_ORIGIN + "/library_index.json",
      ARDUINO_TOOL_HOST_OS: "linux",
      ARDUINO_TOOL_HOST_ARCH: "amd64",
    },
  });

  const client = createArduinoCoreClient({
    service: grpc[CORE_SERVICE_NAME],
    callBinary: (method, requestBase64) => cli.callBinary(method, requestBase64),
  });

  const settings = [
    "directories:",
    "  data: /home/arduino/.arduino15",
    "  downloads: /home/arduino/.arduino15/staging",
    "  user: /home/arduino/Arduino",
  ].join("\n");
  await new Promise((resolve, reject) => {
    client.configurationOpen(
      new settingsPb.ConfigurationOpenRequest().setEncodedSettings(settings).setSettingsFormat("yaml"),
      (error) => (error ? reject(error) : resolve()),
    );
  });

  const instance = await new Promise((resolve, reject) => {
    client.create(new commands.CreateRequest(), (error, response) =>
      error ? reject(error) : resolve(response.getInstance()),
    );
  });

  await new Promise((resolve, reject) => {
    const call = client.init(new commands.InitRequest().setInstance(instance));
    call.on("data", () => {});
    call.on("error", reject);
    call.on("end", resolve);
  });

  console.log("\nthe client an arduino-ide service sees");
  const provider = { client: Promise.resolve({ instance, client }) };

  // Install the fixture platform the way the IDE's own core service does: a
  // streaming PlatformInstall whose progress is wrapped in PlatformInstallResponse.
  const { PlatformInstallRequest } = require("./node/cli-protocol/cc/arduino/cli/commands/v1/core_pb.js");
  const install = new PlatformInstallRequest()
    .setInstance(instance)
    .setPlatformPackage("testpkg")
    .setArchitecture("avr")
    .setVersion("1.0.0")
    .setSkipPostInstall(true);
  await new Promise((resolve, reject) => {
    const call = client.platformInstall(install);
    call.on("data", () => {});
    call.on("error", reject);
    call.on("end", resolve);
  });

  const boards = new BoardsServiceImpl();
  boards.coreClientProvider = provider;

  console.log("\nBoardsServiceImpl.getInstalledPlatforms()");
  const platforms = await boards.getInstalledPlatforms();
  console.log("  " + JSON.stringify(platforms.map((platform) => platform.id)));
  check(
    platforms.some((platform) => platform.id === "testpkg:avr"),
    "the service turned platformSearch into an installed platform",
  );

  console.log("\nBoardsServiceImpl.getInstalledBoards()");
  const installed = await boards.getInstalledBoards();
  console.log("  " + JSON.stringify(installed.map((board) => board.name)));
  check(
    installed.some((board) => board.name === "Test Board"),
    "the service turned boardListAll into a board the board manager can show",
  );

  console.log("\nBoardsServiceImpl.search({ query: 'Test' })");
  const found = await boards.search({ query: "Test" });
  console.log("  " + JSON.stringify(found.map((board) => board.name)));
  check(found.length > 0, "board search reaches the CLI through the service");

  console.log("\nLibraryServiceImpl.search({ query: 'TestLib' })");
  const libraries = new LibraryServiceImpl();
  libraries.coreClientProvider = provider;
  libraries.logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    log: () => {},
    child: () => libraries.logger,
  };
  // The page supplies the notification interface; here every method is recorded
  // instead of shown, which also lists what a page has to implement.
  const notified = [];
  libraries.notificationServer = new Proxy(
    {},
    {
      get: (_target, name) => (...args) => {
        notified.push(String(name));
        return undefined;
      },
    },
  );
  libraries.responseService = { appendToOutput: () => {} };
  // Install stops the serial board discovery first; the page has no discovery, so
  // it accepts the start/stop it is given.
  libraries.boardDiscovery = { start: () => {}, stop: () => {} };

  // The library manager searches the library index, so it has to exist first.
  const { UpdateLibrariesIndexRequest } = require("./node/cli-protocol/cc/arduino/cli/commands/v1/commands_pb.js");
  await new Promise((resolve, reject) => {
    const call = client.updateLibrariesIndex(new UpdateLibrariesIndexRequest().setInstance(instance));
    call.on("data", () => {});
    call.on("error", reject);
    call.on("end", resolve);
  });

  const libraryFound = await libraries.search({ query: "TestLib" });
  console.log("  " + JSON.stringify(libraryFound.map((item) => item.name)));
  check(
    libraryFound.some((item) => item.name === "TestLib"),
    "library search reaches the CLI through the service",
  );

  await libraries.install({ item: libraryFound.find((item) => item.name === "TestLib") });
  console.log("  notifications the page must implement: " + JSON.stringify([...new Set(notified)]));

  const listed = await libraries.list({});
  console.log("  " + JSON.stringify(listed.map((item) => item.name)));
  check(
    listed.some((item) => item.name === "TestLib"),
    "the library manager lists the installed library",
  );

  console.log("\nall checks passed");
}

main().catch((error) => {
  console.error("\n" + (error && error.stack ? error.stack : String(error)));
  // Not `process`: startCLI installs the page's shim as the global, and the
  // shim's objects do not carry an exit code out of the process.
  realProcess.exitCode = 1;
});
