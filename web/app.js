// Browser front end for the WebAssembly build of arduino-cli.
//
// The page owns three things: the storage backend (IndexedDB), the process
// environment the Go runtime expects (fs/path/process), and the calls into the
// CLI. Everything else is the CLI's own work.

import { createNodeFS, IdbBackend, MemoryBackend, deleteDatabase } from "./nodefs.js";

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

// The index URLs are the only configuration the page stores. An empty value
// means "use the URL compiled into the CLI", which is Arduino's own.
const CONFIG_KEYS = {
  defaultIndex: "arduino.index.default",
  extraIndexes: "arduino.index.extra",
  libraryIndex: "arduino.index.library",
};

function readConfig() {
  const config = {};
  for (const [name, key] of Object.entries(CONFIG_KEYS)) {
    config[name] = globalThis.localStorage?.getItem(key) ?? "";
  }
  return config;
}

function extraIndexUrls(config) {
  return config.extraIndexes.split(/[\s,]+/).filter(Boolean);
}

function settingsYaml(config) {
  const lines = [
    "directories:",
    "  data: /home/arduino/.arduino15",
    "  downloads: /home/arduino/.arduino15/staging",
    "  user: /home/arduino/Arduino",
  ];
  const extra = extraIndexUrls(config);
  if (extra.length) {
    lines.push("board_manager:", "  additional_urls:");
    for (const url of extra) lines.push(`    - ${JSON.stringify(url)}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function boot() {
  const config = readConfig();
  $("index-default").value = config.defaultIndex;
  $("index-extra").value = config.extraIndexes;
  $("index-library").value = config.libraryIndex;

  const version = await loadJSON("version.json");
  setStatus(`arduino-cli ${version.arduinoCli}, ${(version.wasmBytes / 1e6).toFixed(1)} MB wasm`);

  const backend = globalThis.indexedDB ? new IdbBackend("arduino-wasm") : new MemoryBackend();
  if (!globalThis.indexedDB) {
    log("no IndexedDB here; files are kept in memory only", "err");
  }
  const shim = createNodeFS({
    backend,
    stdout: (text) => log(text),
    stderr: (text) => log(text, "err"),
    cwd: "/home/arduino",
  });
  await shim.ready();
  globalThis.fs = shim.fs;
  globalThis.path = shim.path;
  globalThis.process = shim.process;

  // wasm_exec.js is a classic script, already loaded by the page. It installs
  // globalThis.Go and leaves our fs/path/process alone because they exist.
  const go = new globalThis.Go();
  go.argv = ["arduino-cli"];
  go.env = { HOME: "/home/arduino", TMPDIR: "/tmp", PATH: "/bin" };
  if (config.defaultIndex) go.env.ARDUINO_DEFAULT_INDEX_URL = config.defaultIndex;
  if (config.libraryIndex) go.env.ARDUINO_LIBRARIES_INDEX_URL = config.libraryIndex;
  go.exit = (code) => log(`the CLI exited with code ${code}`, "err");

  const ready = new Promise((resolve) => {
    globalThis.arduinoCLIReady = resolve;
  });
  const response = await fetch("arduino-cli.wasm");
  if (!response.ok) {
    throw new Error(`arduino-cli.wasm is not readable (${response.status}): ${MISSING_BUILD}`);
  }
  const { instance: wasm } = await WebAssembly.instantiateStreaming(response, go.importObject);
  go.run(wasm); // never settles; the Go program blocks on select {}
  await ready;
  cli = globalThis.arduinoCLI;

  log("CLI loaded");
  await startInstance(config);
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

async function updateIndexes() {
  busy(true);
  log("Updating package indexes");
  try {
    const result = await call("UpdateIndex", { instance, updateIfOlderThanSecs: 0 });
    for (const report of result.flatMap((event) => event.data?.updatedIndexes ?? [])) {
      log(`  ${report.indexUrl} ${report.status}`, report.status === "STATUS_UPDATED" ? "ok" : "err");
    }
  } catch (error) {
    log(`  ${error.message}`, "err");
  }

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
// Wiring

$("update").onclick = () => updateIndexes().catch((error) => {
  log(error.message, "err");
  busy(false);
});
$("index-apply").onclick = () => {
  globalThis.localStorage?.setItem(CONFIG_KEYS.defaultIndex, $("index-default").value.trim());
  globalThis.localStorage?.setItem(CONFIG_KEYS.extraIndexes, $("index-extra").value.trim());
  globalThis.localStorage?.setItem(CONFIG_KEYS.libraryIndex, $("index-library").value.trim());
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

boot().catch((error) => {
  setStatus("failed to start");
  log(error.stack || String(error), "err");
  busy(false);
});
