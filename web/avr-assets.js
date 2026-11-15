// Loading the wasm toolchain's assets, identically in the page and in a test.
//
// The repository carries the .wasm files gzipped and decompresses them here, so
// the tree is 6.2 MB instead of 16 MB. Everything this module does is bytes in,
// bytes out: the driver never learns where they came from, which is why the
// same code runs against an HTTP origin and against a local directory.

import { gunzip } from "./tar.js";

export function createAvrAssets({ load, importModule }) {
  const cache = new Map();

  async function readAsset(name) {
    if (cache.has(name)) return cache.get(name);
    // "sysroot.tar.gz" is already compressed and is handed on untouched;
    // "cc1plus.wasm" ships as "cc1plus.wasm.gz" and is decompressed here.
    const stored = name.endsWith(".gz") ? name : name + ".gz";
    const bytes = await load(stored);
    const value = stored === name ? bytes : await gunzip(bytes);
    cache.set(name, value);
    return value;
  }

  return { readAsset, importModule };
}
