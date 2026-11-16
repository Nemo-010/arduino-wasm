// The CLI page in a real browser, end to end: boot the wasm, install
// arduino:avr from the index the page ships, compile, and read the bytes the
// page shows.
//
// Why this exists next to `test/page-compile.mjs`, which does the same compile
// under Node: the page's `process` shim is Node-like on purpose, and that is
// exactly the difference a Node host cannot see. Emscripten's loaders read
// `process.versions.node` to decide whether they may `import("module")`, so a
// page whose shim looks like Node sends the compiler down a branch that only
// works under Node. `web/tool-common.js`'s `createToolInstance()` is the fix,
// and this test is the one that would notice if it went away.
//
// No socket is involved: the index lives under `web/indexes/avr` and its URLs
// point at a synthetic origin the page maps onto its own directory. The page is
// loaded over `file://` with `--allow-file-access-from-files`, because this
// sandbox cannot bind a TCP port (`EACCES`).
//
// Run: node test/page-browser.mjs
// Not in CI: the runner has no Chrome, and installing one there would grade a
// different browser from the one the page is used in. `test/page-compile.mjs`
// is the Node-side half that CI does run.
// Exit: 0 pass, 1 a check failed, 2 a precondition is missing (browser, page
//       assets, or a built page).
// Writes: build/page-browser.png

import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CHROME, launch } from "./cdp.mjs";

const realProcess = process;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const page = join(root, "web", "index.html");
const shot = join(root, "build", "page-browser.png");
const profile = "/tmp/arduino-page-browser-" + realProcess.pid;

const assets = [
  "arduino-cli.wasm",
  "tools/avr/cc1plus.wasm.gz",
  "tools/avr/sysroot.tar.gz",
  "indexes/avr/package_index.json",
  "indexes/avr/avr-1.8.6.tar.bz2",
];

let failures = 0;
function ok(condition, message, datum) {
  if (condition) {
    console.log("  ok   " + message);
    return;
  }
  failures += 1;
  console.log("  FAIL " + message);
  if (datum !== undefined) console.log("        " + JSON.stringify(String(datum).slice(0, 600)));
}

const missingAssets = assets.filter((name) => !existsSync(join(root, "web", name)));
if (missingAssets.length) {
  console.log("missing: " + missingAssets.join(", ") + " under web/");
  console.log("  build them: python3 scripts/update.py && python3 scripts/fetch-avr-tools.py && python3 scripts/make-avr-index.py --out web/indexes/avr");
  realProcess.exit(2);
}
if (!existsSync(page)) {
  console.log("missing: " + page);
  realProcess.exit(2);
}
if (!existsSync(CHROME)) {
  console.log("missing browser: " + CHROME);
  console.log("  set ARDUINO_WASM_CHROME to a Chrome or Chromium binary");
  realProcess.exit(2);
}

const START = Date.now();
try {
  const { state } = await launch({
    url: pathToFileURL(page).href,
    waitMs: 2000,
    shot,
    profile,
    steps: [
      {
        until: (value) => /ready|failed/.test(String(value)),
        timeout: 180000,
        wait: 1000,
        evaluate: "document.getElementById('status').textContent",
      },
      { wait: 200, evaluate: "document.getElementById('update').click(); 'updated'" },
      {
        until: (value) => String(value).includes("STATUS_UPDATED"),
        timeout: 120000,
        wait: 1000,
        evaluate: "document.getElementById('log').textContent",
      },
      {
        wait: 200,
        evaluate: "document.getElementById('core-install-avr').click(); 'installing'",
      },
      {
        until: (value) => String(value) === "false",
        timeout: 600000,
        wait: 2000,
        evaluate: "String(document.getElementById('core-install-avr').disabled)",
      },
      {
        wait: 200,
        evaluate:
          "document.getElementById('compile-fqbn').value = 'arduino:avr:uno';" +
          "document.getElementById('compile').click(); 'compiling'",
      },
      {
        until: (value) => /bytes of flash/.test(String(value)),
        timeout: 600000,
        wait: 3000,
        evaluate: "document.getElementById('compile-status').textContent",
      },
      {
        wait: 500,
        evaluate:
          "JSON.stringify({ status: document.getElementById('status').textContent," +
          " compile: document.getElementById('compile-status').textContent," +
          " hex: !document.getElementById('hex-download').hidden," +
          " hexName: document.getElementById('hex-download').download," +
          " log: document.getElementById('log').textContent.slice(-400) })",
      },
    ],
  });

  const [boot, , , , , , , final] = state.steps.map(String);
  const ui = JSON.parse(final);

  ok(/^arduino-cli v/.test(boot), "the page booted the wasm CLI: " + boot.slice(0, 60));
  ok(/^\d+ bytes of flash, [\d.]+ s$/.test(ui.compile), "the page shows bytes and seconds: " + ui.compile);
  ok(ui.hex === true, "the page offers the .hex");
  ok(
    ui.hex !== true || ui.hexName === "Sketch.ino.hex",
    "the .hex is named after the sketch: " + ui.hexName,
  );
  ok(!/failed/.test(ui.log), "the log pane shows no failure");
  ok(ui.status.startsWith("arduino-cli v"), "the page stayed ready: " + ui.status.slice(0, 60));

  console.log("\n  screenshot: " + shot);
  console.log("  " + Math.round((Date.now() - START) / 1000) + " s");
} catch (error) {
  failures += 1;
  console.log("  FAIL the run did not finish: " + (error && error.stack ? error.stack : String(error)));
} finally {
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
realProcess.exitCode = failures === 0 ? 0 : 1;
