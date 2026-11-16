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
// CI runs this too, with the runner's Chrome in ARDUINO_WASM_CHROME. The browser
// version is printed at the start: a toolchain wasm that works in one Chrome can
// fail to instantiate in another, and that difference is part of the result.
// Exit: 0 pass, 1 a check failed, 2 a precondition is missing (browser, page
//       assets, or a built page).
// Writes: build/page-browser.png

import { spawnSync } from "node:child_process";
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

console.log("  chrome: " + String(spawnSync(CHROME, ["--version"], { encoding: "utf8" }).stdout || "").trim());

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
        // The button is disabled until the CLI is ready. Clicking it before
        // then does nothing, and the old `disabled === false` wait returned
        // immediately -- CI compiled before the platform existed and failed
        // with `Platform 'arduino:avr' not found`.
        until: (value) => String(value) === "false",
        timeout: 180000,
        wait: 1000,
        evaluate: "String(document.getElementById('core-install-avr').disabled)",
      },
      {
        wait: 200,
        evaluate: "document.getElementById('core-install-avr').click(); 'installing'",
      },
      {
        // Re-enabling the button means the install FINISHED, not that it
        // worked: installCoreNamed clears `disabled` in its catch too. Wait for
        // the page's own success line, but stop as soon as a started install
        // is over so a failure names itself instead of eating the timeout.
        until: (value) => {
          const s = JSON.parse(String(value));
          return s.installed === true || s.enabled === true;
        },
        timeout: 600000,
        wait: 2000,
        evaluate:
          "JSON.stringify({" +
          "  started: document.getElementById('log').textContent.includes('Installing arduino:avr')," +
          "  installed: document.getElementById('log').textContent.includes('Installed arduino:avr')," +
          "  enabled: document.getElementById('core-install-avr').disabled === false," +
          "  tail: document.getElementById('log').textContent.slice(-500)" +
          "})",
      },
      {
        wait: 200,
        evaluate:
          "document.getElementById('compile-fqbn').value = 'arduino:avr:uno';" +
          "document.getElementById('compile').click(); 'compiling'",
      },
      {
        // Stop on a failed compile as well: waiting the full timeout for a
        // phrase a failed run will never print costs ten minutes and hides the
        // page's own error message.
        until: (value) => /bytes of flash|failed/.test(String(value)),
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

  const [boot, , , , , installedStep, , , final] = state.steps.map(String);
  const install = JSON.parse(installedStep);
  const ui = JSON.parse(final);

  ok(/^arduino-cli v/.test(boot), "the page booted the wasm CLI: " + boot.slice(0, 60));
  ok(install.installed === true, "the page installed arduino:avr", install.tail);
  ok(
    /^\d+ bytes of flash, [\d.]+ s$/.test(ui.compile),
    "the page shows bytes and seconds: " + ui.compile,
    ui.log,
  );
  ok(ui.hex === true, "the page offers the .hex", ui.compile);
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
