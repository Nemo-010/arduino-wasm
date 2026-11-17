// Simulate a user setting up a PCB Cupid Glyph ESP32-C6 in the IDE page and
// trying to upload Blink, with a dummy WebUSB device attached.
//
// This is an instrument, not a claim that the board flashes. It drives the
// page's own service proxies and prints the outcome of each step; it exits 0
// when the simulation itself completed and every outcome was recorded. What
// the page cannot do is reported as a named result, never papered over.
//
// The Glyph C6 is ESP32-C6 hardware. Neither pcbcupid's repository nor
// Espressif's boards.txt has a Glyph-specific board id, so the board selected
// here is the vendor's `esp32:esp32:esp32c6`; the index URL is Espressif's.
//
// Needs the Electrosphere for the index and the platform archives:
//
//   NETWORK=1 node test/board-glyph.mjs [url]
//
// Exit: 0 the simulation ran and reported every outcome, 1 it did not, 2 no
//       NETWORK=1 or no browser. Writes: build/board-glyph.png.

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { CHROME, launch } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "cdp.mjs")).href);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const page = join(root, "web", "ide", "index.html");
const url = process.argv[2] || pathToFileURL(page).href;

if (process.env.NETWORK !== "1") {
  console.log("skipped: NETWORK=1 is required, this test downloads a package index");
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.log("missing browser: " + CHROME);
  process.exit(2);
}
if (!url.startsWith("http") && !existsSync(page)) {
  console.log("missing: " + page + " -- build it with python3 scripts/build-ide.py");
  process.exit(2);
}

const LIBRARY_INDEX = "https://raw.githubusercontent.com/arduino/arduino-cli/v1.6.0/commands/testdata/libraries/test1/library_index.json";
const ESP32_INDEX = "https://espressif.github.io/arduino-esp32/package_esp32_index.json";
const FQBN = "esp32:esp32:esp32c6";

// The page reads these keys itself (web/page-config.js); no test-only switch.
// The USB device is a dummy: it answers the standard WebUSB calls and records
// them, so a real upload attempt would be visible without touching hardware.
const preScript = `
try {
  localStorage.setItem('arduino.index.library', ${JSON.stringify(LIBRARY_INDEX)});
  localStorage.setItem('arduino.index.extra', ${JSON.stringify(ESP32_INDEX)});
} catch (e) {}
(function () {
  var calls = [];
  window.__usbCalls = calls;
  var iface = { interfaceNumber: 0, alternate: { alternateSetting: 0, interfaces: [] } };
  var config = { configurationValue: 1, interfaces: [iface] };
  var device = {
    vendorId: 0x303a, productId: 0x1001,
    usbVersionMajor: 2, usbVersionMinor: 0, usbVersionSubminor: 0,
    deviceClass: 0xff, deviceSubclass: 0xff, deviceProtocol: 0xff,
    deviceVersionMajor: 1, deviceVersionMinor: 0, deviceVersionSubminor: 0,
    product: 'Glyph ESP32-C6 (dummy)', manufacturer: 'PCB Cupid', serialNumber: 'dummy-1',
    configuration: config, configurations: [config], opened: false,
    open: async function () { calls.push('open'); this.opened = true; },
    close: async function () { calls.push('close'); this.opened = false; },
    reset: async function () { calls.push('reset'); },
    selectConfiguration: async function (v) { calls.push('selectConfiguration:' + v); },
    claimInterface: async function (i) { calls.push('claimInterface:' + i); },
    releaseInterface: async function (i) { calls.push('releaseInterface:' + i); },
    transferOut: async function (ep, data) { calls.push('transferOut:' + data.length); return { status: 'ok', bytesWritten: data.length }; },
    transferIn: async function (ep, len) { calls.push('transferIn:' + len); return { status: 'ok', data: new DataView(new Uint8Array(len).buffer) }; },
  };
  var usb = {
    getDevices: async function () { calls.push('getDevices'); return [device]; },
    requestDevice: async function () { calls.push('requestDevice'); return device; },
    addEventListener: function () {}, removeEventListener: function () {},
  };
  Object.defineProperty(navigator, 'usb', { value: usb, configurable: true });
  window.__usbAttached = !!(navigator.usb && navigator.usb.getDevices);
})();
`;

const job = `
window.__job = { stage: 'waiting', done: false, error: null, result: {} };
(async () => {
  const j = window.__job;
  const attempt = async (name, fn) => {
    j.stage = name;
    try { j.result[name] = 'ok ' + String(await fn()).slice(0, 500); }
    catch (e) { j.result[name] = 'ERR ' + String((e && e.message) || e).slice(0, 500); }
  };
  try {
    while (!window.__inpageTargets || !window.__inpageTargets['/services/core-service']) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const t = () => window.__inpageTargets;
    const boards = t()['/services/boards-service'];
    const core = t()['/services/core-service'];
    const sketches = t()['/services/sketches-service'];
    await attempt('config', async () => {
      const raw = await t()['/services/remote-filesystem'].readFile('/home/arduino/.arduino15/arduino-cli.yaml');
      return String(new TextDecoder().decode(raw)).includes('${ESP32_INDEX}') ? 'Espressif index configured' : 'index URL MISSING';
    });
    await attempt('updateIndex', () => core.updateIndex({ types: ['platform'] }));
    await attempt('indexFile', async () => {
      const raw = await t()['/services/remote-filesystem'].readFile('/home/arduino/.arduino15/package_esp32_index.json');
      return String(new TextDecoder().decode(raw)).length + ' bytes';
    });
    await attempt('install', () => boards.install({
      item: { id: 'esp32:esp32', availableVersions: ['3.3.12'], installable: true, types: ['Arduino'] },
    }));
    await attempt('platforms', async () => JSON.stringify(await boards.getInstalledPlatforms()));
    const installed = String(j.result.install || '').startsWith('ok');
    if (!installed) {
      // A user stops at a failed install. Calling compile/upload with a board
      // that is not installed would hang the CLI's tool path, and a timeout
      // here would hide why the flow stopped.
      j.result.compile = 'not reached: platform not installed';
      j.result.upload = 'not reached: platform not installed';
    } else {
      await attempt('board', async () => JSON.stringify(await boards.getBoardDetails({ fqbn: '${FQBN}' })));
      let sketch;
      await attempt('sketch', async () => { sketch = await sketches.createNewSketch(); return sketch.name; });
      if (sketch) {
        await attempt('compile', () => core.compile({
          sketch, fqbn: '${FQBN}', verbose: true, compilerWarnings: 'none',
          optimizeForDebug: false, sourceOverride: {}, exportBinaries: false, clean: false,
        }));
        await attempt('upload', () => core.upload({
          sketch, fqbn: '${FQBN}', verbose: true, verify: false, userFields: [],
          port: { address: '/dev/ttyUSB0', label: 'dummy serial', protocol: 'serial' },
        }));
      }
    }
    j.stage = 'done';
  } catch (error) {
    j.error = String((error && error.stack) || error).slice(0, 1200);
  }
  j.done = true;
})();
'ok';
`;

const read = `JSON.stringify({
  stage: window.__job && window.__job.stage,
  done: window.__job && window.__job.done,
  error: window.__job && window.__job.error,
  result: window.__job && window.__job.result,
  usbAttached: window.__usbAttached === true,
  usbCalls: window.__usbCalls || [],
  real: window.__inpageReal,
  cli: !!window.__arduinoCLIReady,
})`;

const profile = "/tmp/board-glyph-" + process.pid;
let result;
try {
  result = await launch({
    url,
    waitMs: 30000,
    profile,
    shot: join(root, "build", "board-glyph.png"),
    preScript,
    steps: [
      { wait: 30000, evaluate: "document.title" },
      { wait: 500, evaluate: job },
      { until: (v) => String(v).includes('"done":true'), timeout: 1200000, wait: 10000, evaluate: read },
    ],
  });
} catch (error) {
  console.log("FAIL simulation did not finish: " + String((error && error.stack) || error).slice(0, 800));
  process.exit(1);
} finally {
  rmSync(profile, { recursive: true, force: true });
}

let state;
try { state = JSON.parse(String(result.state.steps[2])); } catch { state = null; }
let failures = 0;
const ok = (name, condition, detail) => {
  console.log((condition ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!condition) failures += 1;
};
ok("the page booted its own services", !!state && state.real === "bundled" && state.cli === true,
   state ? String(state.real) + " cli=" + state.cli : String(result.state.steps[2]).slice(0, 300));
ok("a dummy WebUSB device was attached", !!state && state.usbAttached === true, state && JSON.stringify(state.usbCalls));
ok("the simulation reported every step", !!state && state.done === true && state.error === null,
   state ? String(state.error || state.stage) : "no result");
if (state) {
  const r = state.result || {};
  for (const name of ["config", "updateIndex", "install", "platforms", "board", "sketch", "compile", "upload", "indexFile"]) {
    if (r[name] !== undefined) console.log("  " + name + ": " + String(r[name]).slice(0, 240));
  }
  ok("the board setup attempt has a name", typeof r.install === "string" && r.install.length > 0, String(r.install));
  ok("the flash attempt has a name", typeof r.upload === "string" && r.upload.length > 0,
     r.upload === undefined ? "not reached" : String(r.upload).slice(0, 240));
  console.log("  WebUSB calls: " + JSON.stringify(state.usbCalls));
}
console.log("");
console.log("page: " + url);
console.log("shot: " + join(root, "build", "board-glyph.png"));
console.log(failures === 0 ? "simulation complete; see the named outcomes above" : failures + " FAILED");
process.exitCode = failures === 0 ? 0 : 1;
