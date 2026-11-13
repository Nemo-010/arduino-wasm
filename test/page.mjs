// Headless test of the page itself: the real web/app.js, the real wasm, the
// real nodefs shim, with a fake DOM standing in for the browser. It covers the
// wiring (element ids, event payloads, what the CLI returns to each button),
// not layout, CSS, or a real USB stack.
//
// Run with: node test/page.mjs

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fixtureFetch, FIXTURE_ORIGIN } from "./fixture-fetch.mjs";

// app.js replaces globalThis.process with the wasm shim; keep the real one.
const realProcess = process;
const verbose = realProcess.env.VERBOSE === "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "web");

function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("  ok  " + message);
}

// ---------------------------------------------------------------------------
// Just enough DOM for app.js.

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.ownText = "";
    this.className = "";
    this.id = "";
    this.disabled = false;
    this.value = "";
    this.onclick = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent ?? "").join("");
  }
  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }
}

async function buildDocument() {
  const html = await readFile(path.join(web, "index.html"), "utf8");
  const byId = new Map();
  const all = [];
  for (const [, tag, attributes] of html.matchAll(/<([a-zA-Z0-9]+)\b([^>]*)>/g)) {
    const id = /\sid="([^"]+)"/.exec(attributes)?.[1];
    if (!id) continue;
    const element = new Element(tag);
    element.id = id;
    byId.set(id, element);
    all.push(element);
  }

  const document = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => {
      const element = new Element(tag);
      all.push(element);
      return element;
    },
    querySelectorAll: (selector) =>
      selector === "button" ? all.filter((element) => element.tagName === "BUTTON") : [],
  };
  return { document, byId, all };
}

// ---------------------------------------------------------------------------
// Just enough browser for app.js.

function installBrowserGlobals({ document, config }) {
  globalThis.document = document;
  globalThis.location = { reload: () => console.log("  (page would reload)") };
  // Node defines `navigator` and `localStorage` as getter-only globals.
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      store: new Map(Object.entries(config)),
      getItem(key) {
        return this.store.get(key) ?? null;
      },
      setItem(key, value) {
        this.store.set(key, value);
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {},
  });
}

async function waitFor(predicate, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const requests = [];
  const fixture = fixtureFetch(requests);

  const { document, byId } = await buildDocument();
  installBrowserGlobals({
    document,
    config: {
      "arduino.index.default": `${FIXTURE_ORIGIN}/package_fixture_index.json`,
      "arduino.index.extra": "",
      "arduino.index.library": `${FIXTURE_ORIGIN}/library_index.json`,
    },
  });

  // The page's own assets come from disk; anything else is a fixture URL.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://page.test/");
    const name = url.pathname.slice(1);
    if (name === "version.json" || name === "arduino-cli.wasm") {
      const body = await readFile(path.join(web, name));
      return new Response(body, {
        headers: { "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/json" },
      });
    }
    return fixture(input, init);
  };

  // wasm_exec.js installs globalThis.Go; app.js needs it to exist before boot.
  createRequire(import.meta.url)(path.join(web, "wasm_exec.js"));

  const log = () => byId.get("log").textContent;
  const lines = () => log().split("\n");

  console.log("\nBoot");
  await import(pathToFileURL(path.join(web, "app.js")).href);
  await waitFor(
    () => byId.get("status").textContent.includes("ready") || log().includes("failed to start"),
    "boot",
    30000,
  );
  check(!log().includes("failed to start"), "the page booted without an error");
  check(byId.get("status").textContent.includes("arduino-cli v"), "the status line reports the CLI version");
  check(log().includes("CLI loaded"), "the wasm CLI started");
  if (verbose) console.log(log());

  console.log("\nUpdate indexes");
  await byId.get("update").onclick();
  check(
    lines().some((line) => line.includes("package_fixture_index.json") && line.includes("STATUS_UPDATED")),
    "the package index was downloaded through the page",
  );
  check(
    lines().some((line) => line.includes("library_index.json") && line.includes("STATUS_UPDATED")),
    "the library index was downloaded through the page",
  );

  console.log("\nSearch cores");
  byId.get("core-query").value = "avr";
  await byId.get("core-search").onclick();
  const coreRows = byId.get("cores").children;
  check(coreRows.length === 1, "one platform matched");
  check(coreRows[0].textContent.includes("testpkg:avr"), "the platform id is rendered");
  check(coreRows[0].textContent.includes("1.0.0 available"), "the available version is rendered");

  console.log("\nInstall core from the page");
  const coreButton = coreRows[0].children.find((child) => child.tagName === "BUTTON");
  check(Boolean(coreButton), "the row offers an install button");
  await coreButton.onclick();
  check(log().includes("Installed testpkg:avr@1.0.0"), "the core installed");
  check(lines().some((line) => line.includes("testtool")), "its tool dependency was installed too");

  console.log("\nSearch libraries");
  byId.get("library-query").value = "Test";
  await byId.get("library-search").onclick();
  const libraryRows = byId.get("libraries").children;
  check(libraryRows.length === 1, "one library matched");
  check(libraryRows[0].textContent.includes("TestLib"), "the library name is rendered");

  console.log("\nInstall library from the page");
  const libraryButton = libraryRows[0].children.find((child) => child.tagName === "BUTTON");
  await libraryButton.onclick();
  check(log().includes("Installed TestLib@1.0.0"), "the library installed");

  console.log("\nInstalled lists");
  await byId.get("core-installed").onclick();
  check(byId.get("cores").textContent.includes("1.0.0 installed"), "the installed core is listed");
  await byId.get("library-installed").onclick();
  check(byId.get("libraries").textContent.includes("TestLib"), "the installed library is listed");

  console.log("\nWebSerial identify");
  globalThis.navigator.serial = {
    requestPort: async () => ({ getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0043 }) }),
  };
  await byId.get("serial").onclick();
  check(byId.get("serial-status").textContent.includes("0x2341"), "the port's vendor id is shown");
  check(byId.get("boards").textContent.includes("Test Board"), "the board is identified from vid/pid");
  check(byId.get("boards").textContent.includes("testpkg:avr:testboard"), "its FQBN is rendered");

  console.log("\nIndex configuration");
  byId.get("index-default").value = " http://mirror.test/package_index.json ";
  byId.get("index-extra").value = "http://a.test/package_a.json, http://b.test/package_b.json";
  byId.get("index-apply").onclick();
  check(
    globalThis.localStorage.getItem("arduino.index.default") === "http://mirror.test/package_index.json",
    "the default index URL is saved trimmed",
  );
  check(
    globalThis.localStorage.getItem("arduino.index.extra") ===
      "http://a.test/package_a.json, http://b.test/package_b.json",
    "the extra index URLs are saved",
  );

  console.log("\nall checks passed");
}

main().then(
  () => realProcess.exit(0),
  (error) => {
    console.error(error.stack || String(error));
    realProcess.exit(1);
  },
);
