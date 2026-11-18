// End-to-end generic flash in a real browser: compile Blink, pick a fake
// WebSerial device, press Flash, and prove the firmware bytes reached the
// bootloader. No board name is in this test's product path: the CLI builds the
// upload command from platform.txt and the page's flash registry routes it.
//
// Run: node test/page-flash.mjs
// Exit: 0 pass, 1 failed check, 2 a precondition is absent.
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const page = join(root, "web", "index.html");
const shot = join(root, "build", "page-flash.png");
const profile = "/tmp/arduino-page-flash-" + process.pid;

const assets = ["arduino-cli.wasm", "tools/avr/cc1plus.wasm.gz", "tools/avr/sysroot.tar.gz",
  "indexes/avr/package_index.json", "indexes/avr/avr-1.8.6.tar.bz2"];
const missing = assets.filter((name) => !existsSync(join(root, "web", name)));
// CI sets ARDUINO_WASM_CHROME after the build; this step can run earlier.
let chrome = process.env.ARDUINO_WASM_CHROME || "/workspace/.scratch/chrome/chrome-linux64/chrome";
if (!existsSync(chrome)) {
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
    if (found) { chrome = found; break; }
  }
}
process.env.ARDUINO_WASM_CHROME = chrome;
const { launch } = await import("./cdp.mjs");
if (missing.length || !existsSync(page) || !existsSync(chrome)) {
  console.log("missing precondition: " + (missing.join(", ") || (existsSync(page) ? chrome : page)));
  process.exit(2);
}
console.log("  chrome: " + String(spawnSync(chrome, ["--version"], { encoding: "utf8" }).stdout || "").trim());
// A fake WebSerial port that speaks STK500v1 like an Uno bootloader. It is
// installed before the page loads, so the real app code uses it unchanged.
const preScript = `(function () {
  window.__flashWrites = [];
  var pending = [];
  var address = 0;
  var port = {
    opened: false,
    getInfo: function () { return { usbVendorId: 0x2341, usbProductId: 0x0043 }; },
    open: async function () { this.opened = true; },
    close: async function () { this.opened = false; },
    get readable() {
      return new ReadableStream({ pull: function (c) {
        if (pending.length) c.enqueue(Uint8Array.from(pending.splice(0)));
      } });
    },
    get writable() {
      return new WritableStream({ write: function (bytes) {
        var cmd = Array.from(bytes), op = cmd[0], reply = [0x14, 0x10];
        if (op === 0x75) reply = [0x14, 0x1e, 0x95, 0x0f, 0x10];
        if (op === 0x55) address = (cmd[1] | (cmd[2] << 8)) * 2;
        if (op === 0x64) {
          var n = (cmd[2] << 8) | cmd[3];
          var data = cmd.slice(5, 5 + n);
          window.__flashWrites.push({ address: address, bytes: data });
        }
        pending = reply;
      } });
    },
  };
  Object.defineProperty(navigator, 'serial', { configurable: true, value: {
    getPorts: async function () { return [port]; },
    requestPort: async function () { return port; },
    addEventListener: function () {}, removeEventListener: function () {},
  } });
})();`;

let failures = 0;
const ok = (condition, message, detail) => {
  console.log((condition ? "  ok   " : "  FAIL ") + message + (detail === undefined ? "" : "\n    " + String(detail).slice(0, 500)));
  if (!condition) failures += 1;
};

let result;
try {
  result = await launch({
    url: pathToFileURL(page).href, waitMs: 2000, profile, shot, preScript,
    steps: [
      { until: (v) => /ready|failed/.test(String(v)), timeout: 180000, wait: 1000,
        evaluate: "document.getElementById('status').textContent" },
      { wait: 200, evaluate: "document.getElementById('update').click(); 'updated'" },
      { until: (v) => String(v).includes("STATUS_UPDATED"), timeout: 120000, wait: 1000,
        evaluate: "document.getElementById('log').textContent" },
      { until: (v) => String(v) === "false", timeout: 180000, wait: 1000,
        evaluate: "String(document.getElementById('core-install-avr').disabled)" },
      { wait: 200, evaluate: "document.getElementById('core-install-avr').click(); 'installing'" },
      { until: (v) => String(v).includes("Installed arduino:avr"), timeout: 600000, wait: 2000,
        evaluate: "document.getElementById('log').textContent" },
      { wait: 200, evaluate: "document.getElementById('serial').click(); 'picked'" },
      { until: (v) => String(v).includes("0x2341"), timeout: 30000, wait: 500,
        evaluate: "document.getElementById('serial-status').textContent" },
      { wait: 200, evaluate: "document.getElementById('compile').click(); 'compiling'" },
      { until: (v) => /bytes of flash|failed/.test(String(v)), timeout: 600000, wait: 3000,
        evaluate: "document.getElementById('compile-status').textContent" },
      { wait: 200, evaluate: "document.getElementById('flash').click(); 'flashing'" },
      { until: (v) => String(v) === "upload done" || String(v) === "upload failed",
        timeout: 180000, wait: 1000, evaluate: "document.getElementById('flash-status').textContent" },
      { wait: 300, evaluate: `JSON.stringify({
        avrdude: !!(window.__flashTools && window.__flashTools.supports('avrdude')),
        esptool: !!(window.__flashTools && window.__flashTools.supports('esptool.py')),
        nrfutil: !!(window.__flashTools && window.__flashTools.supports('nrfutil', { args: ['nrfutil', 'dfu', 'serial'] })),
      })` },
      { wait: 500, evaluate: `JSON.stringify({
        flash: document.getElementById('flash-status').textContent,
        compile: document.getElementById('compile-status').textContent,
        writes: window.__flashWrites,
        log: document.getElementById('log').textContent.slice(-500)
      })` },
    ],
  });
} catch (error) {
  console.log("FAIL the browser run did not finish: " + String(error).slice(0, 500));
  process.exit(1);
} finally {
  rmSync(profile, { recursive: true, force: true });
}

const final = JSON.parse(String(result.state.steps[result.state.steps.length - 1]));
ok(/bytes of flash/.test(final.compile), "Blink compiled in the page", final.compile);
let registered = null;
try { registered = JSON.parse(String(result.state.steps[result.state.steps.length - 2])); } catch { registered = null; }
ok(registered && registered.avrdude && registered.esptool && registered.nrfutil,
  "the page registered every upload tool it ships", JSON.stringify(registered));
ok(final.flash === "upload done", "the Flash button completed an upload", final.flash + " " + final.log);
ok(Array.isArray(final.writes) && final.writes.length > 0, "the fake bootloader received flash pages", JSON.stringify(final.writes).slice(0, 300));
if (final.writes && final.writes.length) {
  const bytes = final.writes.flatMap((w) => w.bytes);
  ok(bytes.length > 100, "a real firmware image was written", bytes.length + " bytes");
}
console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
