// Opt-in test that talks to the real Electrosphere: it downloads the ESP32
// package index (651 KB) over TLS and checks that the CLI parses it and can
// list its platforms. It does not download a core (hundreds of megabytes).
//
//   NETWORK=1 node test/network.mjs
//
// Run it only when you want to prove the fetch path works against a real
// server; the default test suite is offline and deterministic.

import { startCLI } from "./harness.mjs";

const realProcess = process;

if (realProcess.env.NETWORK !== "1") {
  console.log("skipped: set NETWORK=1 to run");
  realProcess.exit(0);
}

const INDEX_URL = "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json";

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

const cli = await startCLI({
  env: { ARDUINO_DEFAULT_INDEX_URL: INDEX_URL },
});

await cli.call("ConfigurationOpen", {
  encoded_settings: [
    "directories:",
    "  data: /home/arduino/.arduino15",
    "  downloads: /home/arduino/.arduino15/staging",
    "  user: /home/arduino/Arduino",
    "",
  ].join("\n"),
  settings_format: "yaml",
});

const created = await cli.call("Create", {});
const instance = created[0].data.instance;
console.log(`  instance ${instance.id}`);

console.log("\nInit (library index is unreachable from this sandbox; errors ignored)");
await cli.call("Init", { instance }).catch((error) => {
  console.log("  " + error.message);
});

console.log("\nUpdateIndex against " + INDEX_URL);
const started = Date.now();
const update = await cli.call("UpdateIndex", { instance, update_if_older_than_secs: 0 });
const reports = update.flatMap((event) => event.data?.updatedIndexes ?? []);
console.log(`  ${Date.now() - started} ms, ${JSON.stringify(reports)}`);
check(reports.some((report) => report.status === "STATUS_UPDATED"), "index downloaded over TLS");

const indexFile = "/home/arduino/.arduino15/package_esp32_index.json";
const keys = await cli.shim.backend.keys();
check(keys.includes(indexFile), "index written to the data dir");
const stored = await cli.shim.backend.get(indexFile);
console.log(`  ${stored.data.length} bytes on disk`);
check(stored.data.length > 600000, "the full index body arrived");

console.log("\nInit again, now that the index is on disk");
await cli.call("Init", { instance }).catch((error) => console.log("  " + error.message));

console.log("\nPlatformSearch esp32");
const search = await cli.call("PlatformSearch", { instance, search_args: "esp32" });
const platforms = search.flatMap((event) => event.data?.searchOutput ?? []);
const esp32 = platforms.find((platform) => platform.metadata?.id === "esp32:esp32");
const releases = Object.keys(esp32?.releases ?? {});
console.log(`  ${platforms.length} platforms, ${releases.length} releases, latest compatible ${esp32?.latestVersion}`);
check(Boolean(esp32), "esp32:esp32 is known to the CLI");
check(releases.length === 52, "all 52 releases of the index parsed");
check(releases.includes("3.3.12"), "the newest release is among them");

// 3.x depends on arduino:dfu-util, which lives in the official Arduino index.
// That index is unreachable from this sandbox, so the CLI marks 3.x
// incompatible and reports 2.0.9 as the latest usable release. The native
// v1.6.0 binary reports exactly the same number with the same files.
check(esp32?.latestVersion === "2.0.9", "compatibility matches the native CLI for this input");

const newest = esp32?.releases?.["3.3.12"];
console.log(`  3.3.12 contributes ${newest?.boards?.length} boards, e.g. ${(newest?.boards ?? []).slice(0, 3).map((board) => board.name).join(", ")}`);
check((newest?.boards ?? []).length === 9, "the release carries the index's board list");

console.log(failures ? `\n${failures} check(s) failed` : "\nall network checks passed");
realProcess.exit(failures ? 1 : 0);
