// End-to-end AVR compile: the real arduino-cli wasm build, the real AVR
// platform recipes, and the in-page toolchain answering the exec seam.
//
// The platform comes from web/indexes/avr/ rather than from Arduino's index,
// because downloads.arduino.cc answers 403 from this machine. That directory is
// the same one the page ships, so this test exercises the bytes a browser gets.
// Everything below the index — the recipes, the core sources, the checksums,
// the tool layout — is the real thing, and the tool archives the index names
// are dummies that are never executed: the page supplies the compiler.
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 a prerequisite is absent.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startCLI } from "./harness.mjs";
import { createAvrExec } from "../web/avr-exec.js";
import { createAvrAssets } from "../web/avr-assets.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// startCLI replaces globalThis.process with the browser shim, whose exit() is a
// no-op. Keep the real one, or a failing run would report exit 0.
const exitProcess = process.exit.bind(process);
const ROOT = path.join(here, "..");
const TOOLS = path.join(ROOT, "web/tools/avr");
const INDEXES = path.join(ROOT, "web/indexes/avr");
const WASM = path.join(ROOT, "web/arduino-cli.wasm");
const INDEX_ORIGIN = "https://arduino-wasm.invalid";
const INDEX_URL = INDEX_ORIGIN + "/indexes/avr/package_index.json";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log((ok ? "ok   " : "FAIL ") + name + (detail ? " [" + detail + "]" : ""));
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    return false;
  }
}

for (const required of [WASM, path.join(TOOLS, "cc1plus.wasm.gz"), path.join(TOOLS, "sysroot.tar.gz"), path.join(INDEXES, "package_index.json"), path.join(INDEXES, "avr-1.8.6.tar.bz2")]) {
  if (!(await exists(required))) {
    console.log("skipped: missing " + path.relative(ROOT, required) + " (run scripts/update.py, scripts/fetch-avr-tools.py, scripts/make-avr-index.py)");
    process.exit(2);
  }
}

const realFetch = globalThis.fetch;
const fixtureFetch = async (url, options) => {
  const parsed = new URL(typeof url === "string" ? url : url.url);
  if (parsed.origin !== INDEX_ORIGIN) return realFetch(url, options);
  const target = path.join(INDEXES, decodeURIComponent(parsed.pathname).replace(/^\/indexes\/avr\//, ""));
  const data = await readFile(target);
  return new Response(data, { status: 200, headers: { "content-length": String(data.length) } });
};

const cli = await startCLI({
  fetch: fixtureFetch,
  env: {
    ARDUINO_DEFAULT_INDEX_URL: INDEX_URL,
    ARDUINO_TOOL_HOST_OS: "linux",
    ARDUINO_TOOL_HOST_ARCH: "amd64",
  },
});

const fs = cli.shim.fs;
const call = (fn, ...args) =>
  new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value))));

// Count the commands the CLI asks for, and fail loudly if the driver is ever
// bypassed: an unhandled tool must not look like a successful compile.
let commands = 0;
const unanswered = [];
const notes = [];
const assets = createAvrAssets({
  load: (name) => readFile(path.join(TOOLS, name)),
  importModule: (name) => import(pathToFileURL(path.join(TOOLS, name + ".mjs")).href),
});
const exec = createAvrExec({
  nodefs: cli.shim,
  readAsset: assets.readAsset,
  importModule: assets.importModule,
  log: (line) => notes.push(line),
});
globalThis.arduinoExec = (request, callback) => {
  commands += 1;
  if (!/^(avr-|ctags)/.test(path.basename(request.args[0]))) unanswered.push(request.args[0]);
  if (commands % 20 === 0) console.error("  " + commands + " commands");
  return exec(request, (result) => {
    // A recipe that fails must not look like one that ran: the CLI only prints
    // what the tool said, and a silent exit code is where a wasm build hides.
    if (result.code !== 0) {
      const detail = (result.stderr || result.error || "").split("\n").slice(0, 14).join(" | ");
      console.error("  failed " + path.basename(request.args[0]) + " (" + result.code + "): " + detail);
    }
    callback(result);
  });
};

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
const { data: created } = (await cli.call("Create", {}))[0];
const instance = created.instance;

await cli.call("Init", { instance }).catch(() => undefined);
await cli.call("UpdateIndex", { instance, update_if_older_than_secs: 0 }, { timeoutMs: 120000 });
// A second Init is what makes the freshly downloaded index visible to the
// package manager; without it PlatformInstall answers "package arduino not found".
await cli.call("Init", { instance }).catch(() => undefined);

await cli.call(
  "PlatformInstall",
  { instance, platform_package: "arduino", architecture: "avr", version: "1.8.6", skip_post_install: true },
  { timeoutMs: 300000 },
);

const PLATFORM = "/home/arduino/.arduino15/packages/arduino/hardware/avr/1.8.6";
const vfsExists = async (target) => {
  try {
    await call(fs.stat, target);
    return true;
  } catch (error) {
    return false;
  }
};
check("platform arduino:avr@1.8.6 is installed", await vfsExists(path.join(PLATFORM, "platform.txt")));

// The sketch is the smallest one that still exercises the core: pinMode and
// digitalWrite pull in wiring_digital.c, delay pulls in wiring.c.
const SKETCH = "/home/arduino/Blink";
const SOURCE = [
  "void setup() {",
  "  pinMode(LED_BUILTIN, OUTPUT);",
  "}",
  "",
  "void loop() {",
  "  digitalWrite(LED_BUILTIN, HIGH);",
  "  delay(500);",
  "  digitalWrite(LED_BUILTIN, LOW);",
  "  delay(500);",
  "}",
  "",
].join("\n");
await call(fs.mkdir, SKETCH, 0o755).catch(() => undefined);
const fd = await call(fs.open, SKETCH + "/Blink.ino", "w", 0o644);
const bytes = new TextEncoder().encode(SOURCE);
await call(fs.write, fd, bytes, 0, bytes.length, 0);
await call(fs.close, fd);

const started = Date.now();
let compileError = null;
let events = [];
try {
  events = await cli.call("Compile", { instance, fqbn: "arduino:avr:uno", sketch_path: SKETCH, verbose: true }, { timeoutMs: 1800000 });
} catch (error) {
  compileError = error;
  events = error.events ?? [];
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const decoded = events
  .map((event) => {
    if (event.data?.outStream) return Buffer.from(event.data.outStream, "base64").toString();
    if (event.data?.errStream) return Buffer.from(event.data.errStream, "base64").toString();
    if (typeof event.data?.message === "string") return event.data.message + "\n";
    return "";
  })
  .join("");

check("the compile finishes", compileError === null, compileError ? compileError.message : elapsed + " s");
check("the toolchain ran from the page", commands > 0, commands + " commands");
check("no command reached an unimplemented tool", unanswered.length === 0, unanswered.slice(0, 3).join(", "));

const sizeLine = /Sketch uses (\d+) bytes/.exec(decoded);
check("the CLI reports the program size", Boolean(sizeLine), sizeLine ? sizeLine[1] + " bytes" : "no size line");

// The build directory is named after a hash of the sketch path, so find it.
const buildRoot = "/home/arduino/.cache/arduino/sketches";
let buildPath = null;
try {
  for (const name of await call(fs.readdir, buildRoot)) {
    const candidate = buildRoot + "/" + name;
    if (await vfsExists(candidate + "/Blink.ino.elf")) buildPath = candidate;
  }
} catch (error) {
  buildPath = null;
}
check("the build directory holds an ELF", Boolean(buildPath));

let hex = null;
if (buildPath) {
  const elfStat = await call(fs.stat, buildPath + "/Blink.ino.elf");
  check("the linked ELF is not empty", elfStat.size > 1000, elfStat.size + " bytes");
  const coreObjects = (await call(fs.readdir, buildPath + "/core").catch(() => [])).filter((name) => name.endsWith(".o"));
  check("the core produced its objects", coreObjects.length >= 20, coreObjects.length + " objects");

  const hexFd = await call(fs.open, buildPath + "/Blink.ino.hex", "r", 0o644);
  try {
    const hexStat = await call(fs.fstat, hexFd);
    const buffer = new Uint8Array(hexStat.size);
    await call(fs.read, hexFd, buffer, 0, buffer.length, 0);
    hex = new TextDecoder().decode(buffer);
  } finally {
    await call(fs.close, hexFd);
  }

  // The eeprom recipe is a second objcopy with --change-section-lma. It once
  // produced no file at all while the build still reported success, so assert
  // the artefact by name rather than trusting the exit code.
  const eepText = await call(fs.open, buildPath + "/Blink.ino.eep", "r", 0o644)
    .then(async (eepFd) => {
      try {
        const eepStat = await call(fs.fstat, eepFd);
        const buffer = new Uint8Array(eepStat.size);
        await call(fs.read, eepFd, buffer, 0, buffer.length, 0);
        return new TextDecoder().decode(buffer);
      } finally {
        await call(fs.close, eepFd);
      }
    })
    .catch(() => null);
  check("the EEPROM image was written", eepText !== null && verifyEEProm(eepText), eepText === null ? "no .eep file" : eepText.length + " bytes");
}

// An Intel HEX record is ":LLAAAATT<data>CC" and every byte of the record,
// checksum included, sums to zero modulo 256.
function verifyHex(text) {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, reason: "empty" };
  for (const line of lines) {
    if (!line.startsWith(":")) return { ok: false, reason: "no colon: " + line.slice(0, 16) };
    const raw = line.slice(1);
    if (raw.length % 2 !== 0) return { ok: false, reason: "odd length" };
    const bytes = [];
    for (let index = 0; index < raw.length; index += 2) bytes.push(parseInt(raw.slice(index, index + 2), 16));
    if (bytes.some((byte) => Number.isNaN(byte))) return { ok: false, reason: "not hex" };
    const declared = bytes[0];
    if (bytes.length !== declared + 5) return { ok: false, reason: "length byte disagrees" };
    if (bytes.reduce((sum, byte) => sum + byte, 0) % 256 !== 0) return { ok: false, reason: "checksum: " + line.slice(0, 20) };
  }
  const last = lines[lines.length - 1];
  if (last !== ":00000001FF") return { ok: false, reason: "no end record" };
  return { ok: true, records: lines.length };
}

if (hex) {
  const verdict = verifyHex(hex);
  check("the hex is well-formed Intel HEX", verdict.ok, verdict.ok ? verdict.records + " records" : verdict.reason);
  // 0C94 is `jmp <address>` — the first instruction of every AVR program, at
  // address zero. Its presence proves the reset vector was linked in.
  check("the hex starts with the AVR reset vector", hex.toUpperCase().includes("0C94"), hex.slice(0, 24));
} else {
  check("the hex is well-formed Intel HEX", false, "no hex file");
  check("the hex starts with the AVR reset vector", false, "no hex file");
}

// The eeprom file is Intel HEX too, at address zero, and a sketch with no
// EEPROM use still gets one: objcopy writes the empty .eeprom section.
function verifyEEProm(text) {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  if (lines[lines.length - 1] !== ":00000001FF") return false;
  return lines.every((line) => line.startsWith(":") && line.length % 2 === 1);
}

if (compileError || !sizeLine) {
  console.log("\n--- compiler output ---");
  console.log(decoded.split("\n").slice(-40).join("\n"));
}

const suspicious = notes.filter((line) => /without writing|ignores|as token/.test(line));
if (suspicious.length) {
  console.log("\n--- driver notes ---");
  console.log([...new Set(suspicious)].slice(-15).join("\n"));
}

const failed = checks.filter((entry) => !entry.ok);
console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " checks passed");
exitProcess(failed.length ? 1 : 0);
