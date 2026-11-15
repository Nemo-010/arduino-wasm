// Where the page's shipped package indexes live, and how the CLI's absolute
// URLs reach them.
//
// The CLI downloads with the URL written in the index, verbatim — there is no
// base to resolve a relative URL against (measured in
// internal/arduino/resources/download.go:33). So the page ships indexes whose
// URLs are absolute under one synthetic origin, and maps that origin onto its
// own directories here. The mapping is one table rather than one function per
// toolchain: a second copy would drift, and the origin is the page's, not a
// platform's.

export const PAGE_ORIGIN = "https://arduino-wasm.invalid";
export const AVR_BASE = "indexes/avr/";
export const NRF52_BASE = "indexes/nrf52/";
export const AVR_INDEX_URL = PAGE_ORIGIN + "/" + AVR_BASE + "package_index.json";
// Not package_index.json: arduino-cli saves each index under the basename of
// its URL, so two indexes with that name overwrite each other in its data
// directory and one platform silently vanishes.
export const NRF52_INDEX_URL = PAGE_ORIGIN + "/" + NRF52_BASE + "nrf52_index.json";

export function createIndexFetch({
  origin = PAGE_ORIGIN,
  routes,
  base,
  read,
  fallback,
  baseUrl,
} = {}) {
  // routes is the general form; base/read is the single-directory shorthand
  // the first version of this page used, kept because callers in the tests
  // still pass it.
  const table = routes ?? [{ prefix: base ?? AVR_BASE, read }];
  // fetch() resolves a relative URL against the document; this wrapper has to
  // do the same, or "version.json" would throw before reaching the real fetch.
  const resolutionBase =
    baseUrl ?? globalThis.document?.baseURI ?? globalThis.location?.href ?? "http://page.test/";
  return async function indexFetch(input, init) {
    const url = new URL(typeof input === "string" ? input : input.url, resolutionBase);
    if (url.origin !== origin) return fallback(input, init);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const route = table.find((candidate) => relative.startsWith(candidate.prefix));
    if (!route) {
      throw new Error(
        "index URL outside the shipped directories (" +
          table.map((candidate) => candidate.prefix).join(", ") +
          "): " +
          url.pathname,
      );
    }
    const bytes = await route.read(relative.slice(route.prefix.length));
    if (!bytes) throw new Error("the page does not carry " + relative);
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  };
}

// fetch() is refused on file://, which is how this page is opened when no
// server is running. XHR is not, so it is the loader. The base is a parameter
// because the indexes and the toolchains live in different directories.
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

// A relative URL is used for the page directory itself, so the same string
// works over http and from file://.
export function installIndexShim({ fallback = globalThis.fetch.bind(globalThis) } = {}) {
  const routes = [AVR_BASE, NRF52_BASE].map((prefix) => ({
    prefix,
    read: makeXhrRead(prefix),
  }));
  globalThis.fetch = createIndexFetch({ routes, fallback });
  return globalThis.fetch;
}
