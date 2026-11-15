// The fake DOM and fake browser that let the page's own JavaScript run under
// Node. Shared so that every page test drives the same shim: two copies of this
// would drift, and the copy that drifts is the one that passes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const web = path.join(here, "..", "web");
export const WEB_INDEX_URL = pathToFileURL(path.join(web, "index.html")).href;

export function check(condition, message) {
  if (!condition) throw new Error("FAILED: " + message);
  console.log("  ok  " + message);
}

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

// Reads the ids the page uses straight out of index.html, so a renamed or
// removed id fails here rather than as a null dereference later.
export async function buildDocument({ baseURI = WEB_INDEX_URL } = {}) {
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
    baseURI,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => {
      const element = new Element(tag);
      all.push(element);
      return element;
    },
    querySelectorAll: (selector) =>
      selector === "button" ? all.filter((element) => element.tagName === "BUTTON") : [],
  };

  // A textarea's initial text is its .value in a browser. Without this the page
  // would compile an empty sketch and look like a compiler bug.
  for (const [, attributes, body] of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const id = /\sid="([^"]+)"/.exec(attributes)?.[1];
    if (!id) continue;
    const element = byId.get(id);
    if (element) element.value = body;
  }

  return { document, byId, all };
}

export function installBrowserGlobals({ document, config }) {
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

// The page reads its toolchain and its index through XMLHttpRequest, because
// fetch() is refused on file://. This is the same request the browser would
// make, answered from the same directory the page ships.
export function installXhr({ root = web } = {}) {
  globalThis.XMLHttpRequest = class {
    constructor() {
      this.status = 0;
      this.response = null;
      this.onload = null;
      this.onerror = null;
    }
    open(method, url) {
      this.url = url;
    }
    send() {
      const target = path.join(root, decodeURI(this.url.split("?")[0]));
      readFile(target)
        .then((bytes) => {
          this.status = 200;
          this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          this.onload?.();
        })
        .catch(() => {
          this.status = 404;
          this.onload?.();
        });
    }
  };
}

export async function waitFor(predicate, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
