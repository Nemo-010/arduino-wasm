// Browser front end for the WebAssembly build of arduino-cli.
//
// The page owns three things: the storage backend (IndexedDB), the process
// environment the Go runtime expects (fs/path/process), and the calls into the
// CLI. Everything else is the CLI's own work.

import { deleteDatabase } from "./nodefs.js";
import { startPageCLI } from "./bootstrap.js";
import { AVR_INDEX_URL, NRF52_INDEX_URL, installIndexShim } from "./page-index.js";
import { CONFIG_KEYS, extraIndexUrls, readConfig, settingsYaml } from "./page-config.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");

// The build output is not committed; the page says so instead of failing with
// a JSON parse error when the wasm has never been built here.
const MISSING_BUILD = "build it first: python3 scripts/update.py";

async function loadJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} is not readable (${response.status}): ${MISSING_BUILD}`);
  return response.json();
}

let cli = null;
let instance = null;

function log(text, kind = "") {
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = text;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  $("status").textContent = text;
}

function busy(on) {
  for (const button of document.querySelectorAll("button")) button.disabled = on;
}

// call() resolves with every event the RPC produced, or rejects with the
// error event's message. Progress events are forwarded to the log as they
// arrive so long downloads do not look like a hang.
function call(method, request, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let lastPercent = -1;
    // The bridge hands back one JSON string per event.
    globalThis.arduinoCLI.call(method, JSON.stringify(request), (raw) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.type === "error") {
        reject(Object.assign(new Error(event.message), { events }));
        return;
      }
      if (event.type === "done") {
        resolve(events);
        return;
      }
      if (quiet) return;
      if (event.type === "progress" && event.data?.update) {
        const { downloaded, totalSize } = event.data.update;
        const total = Number(totalSize);
        if (total > 0) {
          const percent = Math.floor((Number(downloaded) / total) * 100);
          if (percent !== lastPercent && percent % 10 === 0) {
            lastPercent = percent;
            log(`  ${percent}%`);
          }
        }
        return;
      }
      if (event.type === "task" && event.data?.name) {
        log(`  ${event.data.name}`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  const config = readConfig();
  // Blank means "the index this page carries". Arduino's own index cannot be
  // reached from a page anyway (it sends no access-control-allow-origin), and
  // the CLI reads the URL out of the index verbatim, so the shipped index has
  // to come from this page's own directory.
  const defaultIndex = config.defaultIndex || AVR_INDEX_URL;
  installIndexShim();
  $("index-default").value = defaultIndex;
  // The nRF52 index ships with the page for the same reason the AVR one does,
  // and it is registered by default so that a board from it is one click away
  // rather than a URL the user has to know.
  $("index-extra").value = config.extraIndexes || NRF52_INDEX_URL;
  $("index-library").value = config.libraryIndex;

  const version = await loadJSON("version.json");
  setStatus(`arduino-cli ${version.arduinoCli}, ${(version.wasmBytes / 1e6).toFixed(1)} MB wasm`);

  // The CLI's environment is frozen when the Go program starts, so everything it
  // needs for its whole life is passed here.
  const goEnv = {};
  // Always set: defaultIndex falls back to the index this page carries.
  goEnv.ARDUINO_DEFAULT_INDEX_URL = defaultIndex;
  if (config.libraryIndex) goEnv.ARDUINO_LIBRARIES_INDEX_URL = config.libraryIndex;
  if (config.gateway) goEnv.ARDUINO_CORS_GATEWAY = config.gateway;

  const { cli: started } = await startPageCLI({ log, goEnv, wasmUrl: "arduino-cli.wasm" });
  cli = started;

  log("CLI loaded");
  // The field was just prefilled for the user, so it is also what gets
  // registered: showing a URL that the settings do not contain would be a lie,
  // and the nRF52 index would need a second click on "Save and reload".
  await startInstance({ ...config, extraIndexes: $("index-extra").value });
}

async function startInstance(config) {
  await call("ConfigurationOpen", {
    encodedSettings: settingsYaml(config),
    settingsFormat: "yaml",
  });

  const created = await call("Create", {});
  instance = created.find((event) => event.type === "result")?.data?.instance;
  if (!instance) throw new Error("the CLI did not return an instance");

  await init();
  busy(false);
  setStatus(`${$("status").textContent} — ready`);
}

// init() is also the way to make the CLI pick up indexes that were just
// downloaded; it reloads the platform and library managers.
async function init() {
  const events = await call("Init", { instance }).catch((error) => {
    for (const event of error.events ?? []) {
      if (event.type === "init" && event.data?.error) log(event.data.error.message, "err");
    }
    return [];
  });
  for (const event of events) {
    if (event.type === "init" && event.data?.error) log(event.data.error.message, "err");
  }
}

// ---------------------------------------------------------------------------
// Indexes

// The package indexes, without the library index. Installing a core needs only
// the former, and the latter is a 30 MB download from a host that may refuse
// this page, so it is not dragged into an install.
async function updatePackageIndexes() {
  log("Updating package indexes");
  try {
    const result = await call("UpdateIndex", { instance, updateIfOlderThanSecs: 0 });
    for (const report of result.flatMap((event) => event.data?.updatedIndexes ?? [])) {
      log(`  ${report.indexUrl} ${report.status}`, report.status === "STATUS_UPDATED" ? "ok" : "err");
    }
  } catch (error) {
    log(`  ${error.message}`, "err");
  }
  await init();
}

async function updateIndexes() {
  busy(true);
  await updatePackageIndexes();

  log("Updating library index");
  try {
    const libraries = await call("UpdateLibrariesIndex", { instance, updateIfOlderThanSecs: 0 });
    for (const event of libraries) {
      if (event.data?.librariesIndex) {
        log(`  ${event.data.librariesIndex.indexUrl} ${event.data.librariesIndex.status}`, "ok");
      }
    }
  } catch (error) {
    log(`  ${error.message}`, "err");
  }

  await init();
  busy(false);
}

// ---------------------------------------------------------------------------
// Cores

function renderCores(rows) {
  const list = $("cores");
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.title;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = row.detail;
    li.append(name, meta);
    if (row.install) {
      const button = document.createElement("button");
      button.textContent = row.install.label;
      button.onclick = () => row.install.run(button);
      li.append(button);
    }
    list.append(li);
  }
}

async function searchCores() {
  busy(true);
  const query = $("core-query").value.trim();
  const events = await call("PlatformSearch", { instance, searchArgs: query });
  const platforms = events.flatMap((event) => event.data?.searchOutput ?? []);
  log(`${platforms.length} platform(s) matching "${query}"`);

  renderCores(
    platforms.map((platform) => {
      const id = platform.metadata?.id ?? "";
      const [packager, architecture] = id.split(":");
      const installed = platform.installedVersion;
      const latest = platform.latestVersion;
      const target = installed || latest;
      return {
        title: id,
        detail: installed ? `${installed} installed` : latest ? `${latest} available` : "no usable release",
        install: target && target !== installed
          ? {
              label: `Install ${target}`,
              run: async (button) => {
                button.disabled = true;
                await installCore(packager, architecture, target);
                button.disabled = false;
              },
            }
          : null,
      };
    }),
  );
  busy(false);
}

async function installCore(packager, architecture, version) {
  busy(true);
  log(`Installing ${packager}:${architecture}@${version}`);
  try {
    await updatePackageIndexes();
    await call("PlatformInstall", {
      instance,
      platformPackage: packager,
      architecture,
      version,
      skipPostInstall: true,
    });
    log(`Installed ${packager}:${architecture}@${version}`, "ok");
    await init();
  } catch (error) {
    log(error.message, "err");
  }
  busy(false);
}

async function listInstalledCores() {
  busy(true);
  const events = await call("PlatformSearch", { instance, searchArgs: "" });
  const installed = events
    .flatMap((event) => event.data?.searchOutput ?? [])
    .filter((platform) => platform.installedVersion);
  log(`${installed.length} platform(s) installed`);
  renderCores(
    installed.map((platform) => ({
      title: platform.metadata?.id ?? "",
      detail: `${platform.installedVersion} installed`,
      install: null,
    })),
  );
  busy(false);
}

// ---------------------------------------------------------------------------
// Libraries

function renderLibraries(rows) {
  const list = $("libraries");
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.title;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = row.detail;
    li.append(name, meta);
    if (row.install) {
      const button = document.createElement("button");
      button.textContent = row.install.label;
      button.onclick = () => row.install.run(button);
      li.append(button);
    }
    list.append(li);
  }
}

async function searchLibraries() {
  busy(true);
  const query = $("library-query").value.trim();
  const events = await call("LibrarySearch", {
    instance,
    searchArgs: query,
    omitReleasesDetails: true,
  });
  const libraries = events.flatMap((event) => event.data?.libraries ?? []);
  log(`${libraries.length} library(ies) matching "${query}"`);
  renderLibraries(
    libraries.map((library) => {
      const latest = library.latest?.version;
      return {
        title: library.name,
        detail: latest ? `${latest} — ${library.latest.sentence ?? ""}` : "",
        install: latest
          ? {
              label: `Install ${latest}`,
              run: async (button) => {
                button.disabled = true;
                await installLibrary(library.name, latest);
                button.disabled = false;
              },
            }
          : null,
      };
    }),
  );
  busy(false);
}

async function installLibrary(name, version) {
  busy(true);
  log(`Installing ${name}@${version}`);
  try {
    await call("LibraryInstall", { instance, name, version });
    log(`Installed ${name}@${version}`, "ok");
    await init();
  } catch (error) {
    log(error.message, "err");
  }
  busy(false);
}

async function listInstalledLibraries() {
  busy(true);
  const events = await call("LibraryList", { instance, all: true });
  const installed = events.flatMap((event) => event.data?.installedLibraries ?? []);
  log(`${installed.length} library(ies) installed`);
  renderLibraries(
    installed.map((entry) => ({
      title: entry.library?.name ?? "",
      detail: `${entry.library?.version ?? ""} — ${entry.library?.installDir ?? ""}`,
      install: null,
    })),
  );
  busy(false);
}

// ---------------------------------------------------------------------------
// WebSerial
//
// The CLI identifies boards from a set of port properties, and WebSerial gives
// us exactly the two that matter: the USB vendor and product id. Nothing is
// opened or written; this only asks the CLI which boards match.

async function identifyBoard() {
  if (!navigator.serial) {
    log("this browser has no WebSerial", "err");
    return;
  }
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch {
    log("no device selected");
    return;
  }

  // The same port is what the upload tool must open. Keep the object, not just
  // its ids: a WebSerial port cannot be reconstructed from an address.
  globalThis.__arduinoSerialPort = port;
  // Every wasm upload tool opens a POSIX serial path. Registering it here,
  // once, means a new tool needs no page code at all.
  const { createSerialDevices } = await import("./serial-device.js");
  if (globalThis.__arduinoDevices) {
    for (const [path, device] of createSerialDevices(port)) {
      globalThis.__arduinoDevices.set(path, device);
    }
  }
  const { usbVendorId, usbProductId } = port.getInfo();
  // The CLI compares these against boards.txt values such as `0x2341`, and
  // compares them case-insensitively but not numerically: the `0x` is part of
  // the value it matches on.
  const hex = (value) => "0x" + (value ?? 0).toString(16).padStart(4, "0");
  const properties = {};
  if (usbVendorId) properties.vid = hex(usbVendorId);
  if (usbProductId) properties.pid = hex(usbProductId);
  $("serial-status").textContent = `vid ${properties.vid ?? "?"} pid ${properties.pid ?? "?"}`;
  log(`Device ${properties.vid}:${properties.pid}`);

  busy(true);
  try {
    const events = await call("BoardIdentify", { instance, properties });
    const boards = events.flatMap((event) => event.data?.boards ?? []);
    const list = $("boards");
    list.replaceChildren();
    for (const board of boards) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = board.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = board.fqbn;
      li.append(name, meta);
      list.append(li);
    }
    if (!boards.length) {
      log("no installed platform claims this device", "err");
    }
  } catch (error) {
    log(error.message, "err");
  }
  busy(false);
}

// ---------------------------------------------------------------------------
// Compile

// web/nodefs.js is callback-based; the page needs whole-file operations.
function fsCall(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

// protojson carries the byte streams as base64; the compiler writes UTF-8.
function b64text(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const SKETCH_DIR = "/home/arduino/Sketch";
const SKETCH_FILE = SKETCH_DIR + "/Sketch.ino";

async function writeSketch(text) {
  const fs = globalThis.fs;
  await fsCall(fs, "mkdir", SKETCH_DIR, 0o755).catch(() => undefined);
  const fd = await fsCall(fs, "open", SKETCH_FILE, "w", 0o644);
  const bytes = new TextEncoder().encode(text);
  try {
    await fsCall(fs, "write", fd, bytes, 0, bytes.length, 0);
  } finally {
    await fsCall(fs, "close", fd);
  }
}

// The install button asks the index which release is newest by passing an empty
// version, which parseVersion turns into nil so the package manager picks it.
async function installCoreNamed(packager, architecture, button) {
  const label = `${packager}:${architecture}`;
  busy(true);
  button.disabled = true;
  log(`Installing ${label}`);
  try {
    // A fresh visit has no indexes at all, so an install that assumed one would
    // fail with "package Seeeduino not found" and blame the platform. The
    // page's first run is one click: the index arrives with the install.
    await updatePackageIndexes();
    await call("PlatformInstall", {
      instance,
      platformPackage: packager,
      architecture,
      version: "",
      skipPostInstall: true,
    });
    log(`Installed ${label}`, "ok");
    await init();
  } catch (error) {
    log(`  ${error.message}`, "err");
  }
  button.disabled = false;
  busy(false);
}

// The build directory is named after a hash of the sketch path, so the page
// finds the newest one instead of guessing its name.
async function newestBuildDirectory() {
  const root = "/home/arduino/.cache/arduino/sketches";
  let names = [];
  try {
    names = await fsCall(globalThis.fs, "readdir", root);
  } catch (error) {
    return null;
  }
  for (const name of names) {
    const candidate = root + "/" + name;
    try {
      await fsCall(globalThis.fs, "stat", candidate + "/Sketch.ino.elf");
      return candidate;
    } catch (error) {
      // not this one
    }
  }
  return null;
}

async function readFileBytes(target) {
  const fs = globalThis.fs;
  const fd = await fsCall(fs, "open", target, "r", 0o644);
  try {
    const stat = await fsCall(fs, "fstat", fd);
    const buffer = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = await fsCall(fs, "read", fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== buffer.length) {
      throw new Error(`${target}: read ${offset} of ${buffer.length} bytes`);
    }
    return buffer;
  } finally {
    await fsCall(fs, "close", fd);
  }
}

async function readTextFile(target) {
  return new TextDecoder().decode(await readFileBytes(target));
}

async function compileSketch() {
  const fqbn = $("compile-fqbn").value.trim();
  const out = $("compile-out");
  const status = $("compile-status");
  out.textContent = "";
  status.textContent = "compiling…";
  $("hex-download").hidden = true;
  $("zip-download").hidden = true;
  busy(true);

  const started = Date.now();
  let text = "";
  const absorb = (events) => {
    for (const event of events) {
      const data = event.data ?? {};
      if (data.outStream) text += b64text(data.outStream);
      if (data.errStream) text += b64text(data.errStream);
      if (typeof data.message === "string") text += data.message + "\n";
    }
  };
  let failed = null;
  try {
    await writeSketch($("sketch").value);
    absorb(await call("Compile", { instance, fqbn, sketchPath: SKETCH_DIR, verbose: true }));
  } catch (error) {
    absorb(error.events ?? []);
    text += (text ? "\n" : "") + error.message;
    failed = error.message;
  }

  out.textContent = text.split("\n").slice(-200).join("\n");
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const size = /Sketch uses (\d+) bytes/.exec(text);

  // A failed compile leaves the previous build directory in place, so the .hex
  // is only offered when this run produced one.
  const buildPath = failed ? null : await newestBuildDirectory();
  if (!buildPath) {
    status.textContent = `failed after ${seconds} s`;
    log(`  ${failed ?? "no ELF was produced"}`, "err");
    busy(false);
    return;
  }

  try {
    const hex = await readTextFile(buildPath + "/Sketch.ino.hex");
    const link = $("hex-download");
    link.href = URL.createObjectURL(new Blob([hex], { type: "text/plain" }));
    link.download = "Sketch.ino.hex";
    link.hidden = false;
  } catch (error) {
    log(`no .hex to download: ${error.message}`, "err");
  }

  // Only a board whose platform has a DFU recipe produces a .zip, and for those
  // boards it is the artefact worth keeping: the .hex alone cannot be flashed.
  try {
    const zip = await readFileBytes(buildPath + "/Sketch.ino.zip");
    const link = $("zip-download");
    link.href = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    link.download = "Sketch.ino.zip";
    link.hidden = false;
  } catch (error) {
    // nothing to offer
  }

  status.textContent = (size ? `${size[1]} bytes of flash, ` : "") + `${seconds} s`;
  log(`compiled ${fqbn} in ${seconds} s` + (size ? `, ${size[1]} bytes` : ""), "ok");
  busy(false);
}

// ---------------------------------------------------------------------------
// Wiring

$("update").onclick = () => updateIndexes().catch((error) => {
  log(error.message, "err");
  busy(false);
});
$("index-apply").onclick = () => {
  globalThis.localStorage?.setItem(CONFIG_KEYS.defaultIndex, $("index-default").value.trim());
  globalThis.localStorage?.setItem(CONFIG_KEYS.extraIndexes, $("index-extra").value.trim());
  globalThis.localStorage?.setItem(CONFIG_KEYS.libraryIndex, $("index-library").value.trim());
  globalThis.localStorage?.setItem(CONFIG_KEYS.gateway, $("gateway").value.trim());
  location.reload();
};
$("reset").onclick = async () => {
  busy(true);
  if (globalThis.indexedDB) {
    await deleteDatabase("arduino-wasm");
  }
  log("stored files erased; reloading");
  location.reload();
};
$("core-search").onclick = () => searchCores().catch((error) => log(error.message, "err"));
$("core-installed").onclick = () => listInstalledCores().catch((error) => log(error.message, "err"));
$("library-search").onclick = () => searchLibraries().catch((error) => log(error.message, "err"));
$("library-installed").onclick = () =>
  listInstalledLibraries().catch((error) => log(error.message, "err"));
$("serial").onclick = () => identifyBoard().catch((error) => log(error.message, "err"));

// Upload is generic: the CLI builds the command from the board's own recipe
// and the page's flash registry routes it by tool name. No board is named here.
async function flashSketch() {
  if (!globalThis.__arduinoSerialPort) {
    log("pick a serial device first", "err");
    return;
  }
  const fqbn = $("compile-fqbn").value.trim();
  const status = $("flash-status");
  status.textContent = "uploading…";
  try {
    const events = await call("Upload", {
      instance,
      sketch_path: SKETCH_DIR,
      fqbn,
      port: { address: "serial", protocol: "serial", label: "selected device" },
      verbose: true,
      verify: false,
      user_fields: {},
    });
    const text = events.flatMap((event) => {
      if (event.data?.outStream) return [b64text(event.data.outStream)];
      if (event.data?.errStream) return [b64text(event.data.errStream)];
      return [];
    }).join("");
    status.textContent = /error|failed/i.test(text) ? "upload failed" : "upload done";
    log(text.trim() || "upload finished");
  } catch (error) {
    status.textContent = "upload failed";
    log(error.message, "err");
  }
}
$("flash").onclick = () => flashSketch().catch((error) => log(error.message, "err"));
$("core-install-avr").onclick = () => installCoreNamed("arduino", "avr", $("core-install-avr"));
$("core-install-nrf52").onclick = () =>
  installCoreNamed("Seeeduino", "nrf52", $("core-install-nrf52"));
$("compile-board").onchange = () => {
  if ($("compile-board").value) $("compile-fqbn").value = $("compile-board").value;
};
$("compile").onclick = () => compileSketch().catch((error) => {
  $("compile-status").textContent = error.message;
  log(error.message, "err");
  busy(false);
});

boot().catch((error) => {
  setStatus("failed to start");
  log(error.stack || String(error), "err");
  busy(false);
});
