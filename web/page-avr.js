// The page's half of the AVR toolchain: where the assets come from, and how the
// index's URLs reach them.
//
// The CLI downloads with the URL written in the index, verbatim — there is no
// base to resolve a relative URL against (measured in
// internal/arduino/resources/download.go:33). So the page ships an index whose
// URLs are absolute under a synthetic origin, and maps that origin onto its own
// directory here. The mapping lives in a module rather than in app.js so a test
// can run the same code against a directory instead of a socket.

import { createAvrAssets } from "./avr-assets.js";
import { installAvrExec } from "./avr-exec.js";

export const AVR_ORIGIN = "https://arduino-wasm.invalid";
export const AVR_INDEX_URL = AVR_ORIGIN + "/indexes/avr/package_index.json";
// Relative on purpose: the same string works over http and from file://.
export const AVR_BASE = "indexes/avr/";

export function createIndexFetch({ origin = AVR_ORIGIN, base = AVR_BASE, read, fallback, baseUrl } = {}) {
  // fetch() resolves a relative URL against the document; this wrapper has to
  // do the same, or "version.json" would throw before reaching the real fetch.
  const resolutionBase =
    baseUrl ?? globalThis.document?.baseURI ?? globalThis.location?.href ?? "http://page.test/";
  return async function indexFetch(input, init) {
    const url = new URL(typeof input === "string" ? input : input.url, resolutionBase);
    if (url.origin !== origin) return fallback(input, init);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relative.startsWith(base)) {
      throw new Error("index URL outside the shipped directory: " + url.pathname);
    }
    const bytes = await read(relative.slice(base.length));
    if (!bytes) throw new Error("the page does not carry " + relative);
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  };
}

// fetch() is refused on file://, which is how this page is opened when no
// server is running. XHR is not, so it is the loader. The base is a parameter
// because the index and the toolchain live in different directories.
export function makeXhrRead(base) {
  return function xhrRead(relative) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", base + encodeURI(decodeURI(relative)));
      request.responseType = "arraybuffer";
      request.onload = () => {
        if (request.status === 200 || (request.status === 0 && request.response)) {
          resolve(new Uint8Array(request.response));
        } else {
          reject(new Error("HTTP " + request.status + " for " + relative));
        }
      };
      request.onerror = () => reject(new Error("could not read " + relative));
      request.send();
    });
  };
}

export const xhrRead = makeXhrRead(AVR_BASE);
export const toolRead = makeXhrRead("tools/avr/");

// Installs both halves before the CLI boots: the fetch mapping the index needs,
// and the exec seam the compiler needs. A compile that happens before
// arduinoExec exists fails with "not implemented on js", so this is not optional.
export function installPageAvr({ nodefs, log } = {}) {
  const assets = createAvrAssets({
    load: (name) => toolRead(name),
    importModule: (name) => import(new URL("tools/avr/" + name + ".mjs", document.baseURI).href),
  });
  installAvrExec({ nodefs, readAsset: assets.readAsset, importModule: assets.importModule, log });
  return assets;
}

export function installIndexShim({ fallback = globalThis.fetch.bind(globalThis), read = xhrRead } = {}) {
  globalThis.fetch = createIndexFetch({ read, fallback });
  return globalThis.fetch;
}
