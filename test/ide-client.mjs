// Proves the seam the IDE needs: the generated gRPC service definition, the
// generated message classes, protobuf binary on the wire, and the real
// arduino-cli server answering behind the wasm bridge.
//
// It drives the same sequence the desktop IDE drives against a real daemon --
// ConfigurationOpen, Create, Init, PlatformInstall, BoardListAll -- but through
// the client that ide/inpage/cli-client.mjs builds from the service definition,
// so both the unary callback shape and the streaming event shape are exercised
// by the same code the IDE's services will use.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCLI } from "./harness.mjs";
import { fixtureFetch, FIXTURE_ORIGIN } from "./fixture-fetch.mjs";
import { createArduinoCoreClient, CORE_SERVICE_NAME } from "../ide/inpage/cli-client.mjs";

const realProcess = process;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = join(root, "build/arduino-ide/arduino-ide-extension/lib/node");
const require = createRequire(extension + "/");

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("  ok  " + message);
}

function unary(client, name, request, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(name + ": timed out")), timeoutMs);
    client[name](request, (error, response) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response);
    });
  });
}

// Streaming RPCs in the IDE's client deliver responses as data events and finish
// with end; collect them the same way a service impl does.
function streamed(client, name, request, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const results = [];
    const timer = setTimeout(() => reject(new Error(name + ": timed out")), timeoutMs);
    const call = client[name](request);
    call.on("data", (message) => results.push(message));
    call.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    call.on("end", () => {
      clearTimeout(timer);
      resolve(results);
    });
  });
}

async function main() {
  const origin = FIXTURE_ORIGIN;
  // The build that ships, not a copy in /tmp: a stale file there once made this
  // test grade a wasm from before the bridge carried gRPC codes, and the failure
  // looked like a product defect.
  const wasm = realProcess.env.ARDUINO_WASM_BIN || join(root, "web", "arduino-cli.wasm");
  if (!existsSync(wasm)) {
    console.log("missing: " + wasm);
    console.log("build it first: python3 scripts/update.py");
    realProcess.exit(2);
    return;
  }
  if (!existsSync(extension)) {
    console.log("missing: " + extension);
    console.log("build it first: python3 scripts/build-ide.py");
    realProcess.exit(2);
    return;
  }
  console.log("  wasm: " + wasm);
  const cli = await startCLI({
    wasm,
    fetch: fixtureFetch(),
    env: {
      ARDUINO_DEFAULT_INDEX_URL: origin + "/package_fixture_index.json",
      ARDUINO_LIBRARIES_INDEX_URL: origin + "/library_index.json",
      ARDUINO_TOOL_HOST_OS: "linux",
      ARDUINO_TOOL_HOST_ARCH: "amd64",
    },
  });

  const grpc = require("./cli-protocol/cc/arduino/cli/commands/v1/commands_grpc_pb.js");
  const commands = require("./cli-protocol/cc/arduino/cli/commands/v1/commands_pb.js");
  const boardPb = require("./cli-protocol/cc/arduino/cli/commands/v1/board_pb.js");
  const corePb = require("./cli-protocol/cc/arduino/cli/commands/v1/core_pb.js");
  const settingsPb = require("./cli-protocol/cc/arduino/cli/commands/v1/settings_pb.js");
  const libraryPb = require("./cli-protocol/cc/arduino/cli/commands/v1/lib_pb.js");

  const client = createArduinoCoreClient({
    service: grpc[CORE_SERVICE_NAME],
    // Forward the observer: the client delivers events as they arrive, and a
    // transport that drops it would still "work" while hiding every progress
    // message -- which is exactly the bug this line prevents.
    callBinary: (method, requestBase64, onEvent) => cli.callBinary(method, requestBase64, onEvent),
    // The same class `service-error.js` tests against, so a status this test
    // sees is the status the IDE's services see.
    Metadata: require("@grpc/grpc-js").Metadata,
  });

  console.log("\nVersion (unary, protobuf binary both ways)");
  const version = await unary(client, "version", new commands.VersionRequest());
  console.log("  " + JSON.stringify(version.getVersion()));
  check(/^v?\d+\.\d+\.\d+/.test(version.getVersion()), "the CLI version came back through the client");

  console.log("\nConfigurationOpen");
  const settings = [
    "directories:",
    "  data: /home/arduino/.arduino15",
    "  downloads: /home/arduino/.arduino15/staging",
    "  user: /home/arduino/Arduino",
  ].join("\n");
  await unary(
    client,
    "configurationOpen",
    new settingsPb.ConfigurationOpenRequest().setEncodedSettings(settings).setSettingsFormat("yaml"),
  );
  check(true, "configuration accepted");

  console.log("\nCreate");
  const created = await unary(client, "create", new commands.CreateRequest());
  const instance = created.getInstance();
  check(Number(instance.getId()) > 0, "instance created (id " + instance.getId() + ")");

  console.log("\nInit (streaming)");
  const inits = await streamed(client, "init", new commands.InitRequest().setInstance(instance));
  const initErrors = inits
    .filter((message) => message.hasError())
    .map((message) => message.getError().getMessage());
  console.log("  reported: " + (initErrors.length ? initErrors.join("; ") : "none"));
  check(
    !initErrors.some((message) => message.includes("index")),
    "first Init downloads and loads both indexes",
  );

  console.log("\nPlatformInstall testpkg:avr@1.0.0 (streaming, with progress)");
  const install = await streamed(
    client,
    "platformInstall",
    new corePb.PlatformInstallRequest()
      .setInstance(instance)
      .setPlatformPackage("testpkg")
      .setArchitecture("avr")
      .setVersion("1.0.0")
      .setSkipPostInstall(true),
  );
  const tasks = install.filter((message) => message.hasTaskProgress()).map((message) => message.getTaskProgress());
  const names = [...new Set(tasks.map((task) => task.getName()).filter(Boolean))];
  console.log("  " + tasks.length + " progress messages, tasks: " + names.join(", "));
  check(tasks.length > 0, "the install reported task progress through the stream");
  check(names.some((name) => name.includes("testtool")), "the toolsDependency was installed too");

  console.log("\nBoardListAll (unary; the IDE's board manager path)");
  const boards = await unary(client, "boardListAll", new boardPb.BoardListAllRequest().setInstance(instance));
  const boardNames = boards.getBoardsList().map((board) => board.getName());
  console.log("  " + boardNames.join(", "));
  check(boardNames.includes("Test Board"), "the installed platform's board reaches the client");

  console.log("\nBoardIdentify (what the IDE does for a serial port)");
  const identifyRequest = new boardPb.BoardIdentifyRequest().setInstance(instance);
  identifyRequest.getPropertiesMap().set("vid", "0x2341");
  identifyRequest.getPropertiesMap().set("pid", "0x0043");
  const identified = await unary(client, "boardIdentify", identifyRequest);
  const fqbns = identified.getBoardsList().map((board) => board.getFqbn());
  console.log("  " + JSON.stringify(fqbns));
  check(fqbns.includes("testpkg:avr:testboard"), "a vendor/product pair identifies the board");

  console.log("\nLibraryInstall and LibraryList");
  const librariesIndex = await streamed(
    client,
    "updateLibrariesIndex",
    new commands.UpdateLibrariesIndexRequest().setInstance(instance).setUpdateIfOlderThanSecs(0),
  );
  const libraryResult = librariesIndex.map((message) => message.getResult()).filter(Boolean);
  console.log(
    "  " + (libraryResult.length ? libraryResult.length + " index result messages" : "no index result"),
  );
  check(
    librariesIndex.every((message) => !message.hasResult() || message.getResult().getLibrariesIndex()),
    "the library index was downloaded and parsed",
  );
  const installs = await streamed(
    client,
    "libraryInstall",
    new libraryPb.LibraryInstallRequest().setInstance(instance).setName("TestLib").setVersion("1.0.0"),
  );
  const installTasks = installs
    .filter((message) => message.hasTaskProgress())
    .map((message) => message.getTaskProgress());
  console.log("  " + installTasks.length + " install progress messages");
  check(installTasks.length > 0, "the library install reported progress through the stream");
  const listed = await unary(client, "libraryList", new libraryPb.LibraryListRequest().setInstance(instance).setAll(true));
  const libraries = listed.getInstalledLibrariesList().map((entry) => entry.getLibrary().getName());
  console.log("  " + JSON.stringify(libraries));
  check(libraries.includes("TestLib"), "the installed library reaches the client");

  // A status carries a code, and the extension branches on it: `SketchesServiceImpl`
  // asks `isNotFoundError(err)` and turns NOT_FOUND into "this is not a sketch",
  // which is what `_isSketchFolder` answers for the sketchbook root. A status
  // that said UNKNOWN for every failure made that a boot-time rejection.
  const failure = await unary(
    client,
    "loadSketch",
    new commands.LoadSketchRequest().setSketchPath("/home/arduino/Arduino"),
  ).then(
    () => { throw new Error("loadSketch on a directory that is not a sketch succeeded"); },
    (error) => error,
  );
  console.log("  code " + failure.code + " " + JSON.stringify(failure.details));
  check(failure.code === 5, "a NotFound from the CLI keeps its code (5) through the bridge");
  check(failure instanceof Error, "the failure is an Error, which is what ServiceError.is requires");
  check(typeof failure.details === "string" && failure.details.includes("Can't open sketch"),
    "the failure carries the CLI's own message in details");
  check(failure.metadata && typeof failure.metadata.get === "function",
    "the failure carries Metadata, the other half of ServiceError.is");

  console.log("\nall checks passed");
}

main().catch((error) => {
  console.error("\n" + (error && error.stack ? error.stack : String(error)));
  // Not `process`: startCLI installs the page's shim as the global, and the
  // shim's objects do not carry an exit code out of the process.
  realProcess.exitCode = 1;
});
