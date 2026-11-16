// End-to-end test: drive the wasm arduino-cli through the same sequence the
// desktop IDE uses, against a local package index that points back at this
// server. Everything after this point is arduino-cli's own code: index parsing,
// checksum verification, zip extraction, install layout, library validation.

import { readFileSync } from "node:fs";
import { startCLI } from "./harness.mjs";
import { fixtureFetch, FIXTURE_ORIGIN } from "./fixture-fetch.mjs";
import { ERRNO, fsError } from "../web/nodefs.js";

// startCLI replaces globalThis.process with the wasm shim, so keep the real one.
const realProcess = process;
const verbose = realProcess.env.VERBOSE === "1";


function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("  ok  " + message);
}

// Node's errors carry a numeric `errno`, and code written against Node checks
// it: the IDE's `ErrnoException.is()` refuses an error whose `errno` is not a
// number, so a shim error with only `code` reads as "some error" and the caller
// gives up. That is not a theoretical hazard -- it turned a missing config file
// into a hang. This check reads the codes this file actually raises, so adding
// a code without adding its number fails here rather than at run time.
function checkErrnoTable() {
  const source = readFileSync(new URL("../web/nodefs.js", import.meta.url), "utf8");
  const codes = new Set([...source.matchAll(/fsError\("([A-Z]+)"/g)].map((match) => match[1]));
  const missing = [...codes].filter((code) => !(code in ERRNO));
  if (missing.length > 0) {
    throw new Error("FAILED: fsError codes with no numeric errno in ERRNO: " + missing.join(", "));
  }
  console.log("  ok  every fsError code has a numeric errno (" + codes.size + " codes)");
  const sample = fsError("ENOENT", "/nope");
  check(typeof sample.errno === "number", "a shim error carries a numeric errno");
  check(sample.code === "ENOENT" && sample.errno === -2, "ENOENT maps to Node's -2");
  check(sample.path === "/nope", "a shim error carries the path it failed on");
}

async function main() {
  checkErrnoTable();
  const requests = [];
  const origin = FIXTURE_ORIGIN;

  const cli = await startCLI({
    fetch: fixtureFetch(requests),
    env: {
      ARDUINO_DEFAULT_INDEX_URL: origin + "/package_fixture_index.json",
      ARDUINO_LIBRARIES_INDEX_URL: origin + "/library_index.json",
      ARDUINO_TOOL_HOST_OS: "linux",
      ARDUINO_TOOL_HOST_ARCH: "amd64",
    },
    stderr: (line) => {
      if (verbose) console.log("[cli] " + line);
    },
  });

  const settings = [
    "directories:",
    "  data: /home/arduino/.arduino15",
    "  downloads: /home/arduino/.arduino15/staging",
    "  user: /home/arduino/Arduino",
  ].join("\n");

  console.log("\nConfigurationOpen");
  await cli.call("ConfigurationOpen", { encoded_settings: settings, settings_format: "yaml" });

  const created = await cli.call("Create", {});
  const instance = created.find((event) => event.type === "result").data.instance;
  check(Number(instance.id) > 0, "instance created (id " + instance.id + ")");

  console.log("\nInit on a fresh instance (firstUpdate downloads both indexes)");
  const firstInit = await cli.call("Init", { instance });
  const firstErrors = firstInit
    .filter((event) => event.type === "init" && event.data.error)
    .map((event) => event.data.error.message);
  console.log("  reported: " + (firstErrors.length ? firstErrors.join("\n            ") : "none"));
  check(
    !firstErrors.some((message) => message.includes("index")),
    "first Init downloads and loads both indexes",
  );
  const afterInit = await cli.shim.backend.keys();
  check(afterInit.includes("/home/arduino/.arduino15/package_fixture_index.json"), "package index on disk after Init");
  check(afterInit.includes("/home/arduino/.arduino15/library_index.json"), "library index on disk after Init");

  console.log("\nUpdateIndex");
  const update = await cli.call("UpdateIndex", { instance, update_if_older_than_secs: 0 });
  const reports = update.flatMap((event) => event.data?.updatedIndexes ?? []);
  console.log("  " + JSON.stringify(reports));
  check(reports.some((report) => report.status === "STATUS_UPDATED"), "package index downloaded and installed");

  console.log("\nUpdateLibrariesIndex");
  const librariesUpdate = await cli.call("UpdateLibrariesIndex", { instance, update_if_older_than_secs: 0 });
  const libraryReports = librariesUpdate.flatMap((event) => (event.data?.librariesIndex ? [event.data.librariesIndex] : []));
  console.log("  " + JSON.stringify(libraryReports));
  check(libraryReports.some((report) => report.status === "STATUS_UPDATED"), "library index downloaded and installed");

  console.log("\nInit again, now that both indexes are on disk");
  const secondInit = await cli.call("Init", { instance });
  const secondErrors = secondInit
    .filter((event) => event.type === "init" && event.data.error)
    .map((event) => event.data.error.message);
  console.log("  reported: " + (secondErrors.length ? secondErrors.join("\n            ") : "none"));
  check(
    !secondErrors.some((message) => message.includes("index")),
    "a reloaded instance finds both indexes",
  );

  console.log("\nPlatformInstall testpkg:avr@1.0.0 (plus toolsDependencies)");
  const install = await cli.call(
    "PlatformInstall",
    {
      instance,
      platform_package: "testpkg",
      architecture: "avr",
      version: "1.0.0",
      skip_post_install: true,
    },
    { timeoutMs: 180000 },
  );
  const tasks = install.filter((event) => event.type === "task").map((event) => event.data);
  const names = [...new Set(tasks.map((task) => task.name).filter(Boolean))];
  console.log("  tasks: " + names.join(", "));
  check(tasks.length > 0, "install reported task progress");
  check(names.some((name) => name.includes("testtool")), "the toolsDependency was installed too");

  console.log("\nPlatformSearch (the installed third-party platform)");
  const platforms = await cli.call("PlatformSearch", { instance, search_args: "avr" });
  const found = platforms.flatMap((event) => event.data?.searchOutput ?? []);
  console.log("  " + JSON.stringify(found).slice(0, 700));
  check(
    found.some((platform) => (platform.metadata?.id ?? "").includes("testpkg:avr")),
    "installed platform is listed with its id",
  );

  console.log("\nBoardListAll (boards contributed by that platform)");
  const boards = await cli.call("BoardListAll", { instance });
  const boardNames = boards.flatMap((event) => event.data?.boards ?? []).map((board) => board.name);
  if (!boardNames.length) console.log("  " + JSON.stringify(boards).slice(0, 600));
  console.log("  " + boardNames.join(", "));
  check(boardNames.includes("Test Board"), "the platform's board is visible to the IDE");

  // The same lookup the page performs for a WebSerial port, minus the USB layer.
  console.log("\nBoardIdentify vid 0x2341 pid 0x0043");
  const identified = await cli.call("BoardIdentify", {
    instance,
    properties: { vid: "0x2341", pid: "0x0043" },
  });
  const identifiedBoards = identified.flatMap((event) => event.data?.boards ?? []);
  console.log("  " + JSON.stringify(identifiedBoards.map((board) => board.fqbn)));
  check(
    identifiedBoards.some((board) => board.fqbn === "testpkg:avr:testboard"),
    "a vendor/product pair identifies the board",
  );

  console.log("\nLibraryInstall TestLib@1.0.0");
  await cli.call("LibraryInstall", { instance, name: "TestLib", version: "1.0.0" });

  console.log("\nLibraryList");
  const list = await cli.call("LibraryList", { instance, all: true });
  const entries = list.flatMap((event) => event.data?.installedLibraries ?? []);
  console.log("  " + JSON.stringify(entries));
  const testLib = entries.find((entry) => entry.library?.name === "TestLib");
  check(Boolean(testLib), "library appears in LibraryList");
  check((testLib?.library?.installDir ?? "").includes("libraries/TestLib"), "library install dir is under the user tree");

  console.log("\nLarge file writes");
  // Allocating an exact-size buffer per write is quadratic: 32 MB in 8 KB
  // chunks copies ~64 GB. Geometric capacity growth keeps this under a second.
  const bigPath = "/home/arduino/big.bin";
  const chunk = new Uint8Array(8192).fill(0x5a);
  const writes = 4096;
  const started = Date.now();
  const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value))));
  const bigFd = await call(cli.shim.fs.open, bigPath, "w", 0o644);
  for (let index = 0; index < writes; index += 1) {
    await call(cli.shim.fs.write, bigFd, chunk, 0, chunk.length, null);
  }
  await call(cli.shim.fs.close, bigFd);
  const elapsed = Date.now() - started;
  const big = await cli.shim.backend.get(bigPath);
  check(big.data.length === writes * chunk.length, `32 MB survived the write path (${elapsed} ms)`);
  check(elapsed < 10000, "write growth stays linear");
  await call(cli.shim.fs.unlink, bigPath);

  console.log("\nFilesystem");
  const keys = await cli.shim.backend.keys();
  const expected = [
    "/home/arduino/.arduino15/package_fixture_index.json",
    "/home/arduino/.arduino15/library_index.json",
    "/home/arduino/.arduino15/packages/testpkg/hardware/avr/1.0.0/platform.txt",
    "/home/arduino/.arduino15/packages/testpkg/hardware/avr/1.0.0/boards.txt",
    "/home/arduino/.arduino15/packages/testpkg/hardware/avr/1.0.0/cores/arduino/Arduino.h",
    "/home/arduino/.arduino15/packages/testpkg/tools/testtool/1.0.0/bin/testtool",
    "/home/arduino/Arduino/libraries/TestLib/library.properties",
    "/home/arduino/Arduino/libraries/TestLib/src/TestLib.h",
  ];
  for (const key of expected) check(keys.includes(key), "exists " + key);

  const platformEntry = await cli.shim.backend.get("/home/arduino/.arduino15/packages/testpkg/hardware/avr/1.0.0/platform.txt");
  const platformText = new TextDecoder().decode(platformEntry.data);
  check(platformText.includes("name=Test AVR Boards"), "installed platform.txt has the index's content");

  const usage = await cli.shim.usage();
  console.log("  " + usage.entries + " entries, " + usage.bytes + " bytes");

  console.log("\nHTTP requests made by the CLI");
  for (const request of requests) {
    console.log(`  ${request.method} ${request.bytes} bytes ${request.path}${request.range ? " (range " + request.range + ")" : ""}`);
  }
  check(
    requests.some((request) => request.path === "/core-testavr-1.0.0.zip"),
    "core archive fetched over HTTP",
  );
  check(requests.some((request) => request.path === "/testtool-1.0.0.zip"), "tool archive fetched over HTTP");
  check(requests.some((request) => request.path === "/TestLib-1.0.0.zip"), "library archive fetched over HTTP");

  console.log("\nall checks passed");
}

main().then(
  () => realProcess.exit(0),
  (error) => {
    console.error("\n" + (error?.stack || error));
    realProcess.exit(1);
  },
);
