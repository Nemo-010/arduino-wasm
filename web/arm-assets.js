// Loading the ARM toolchain's assets, identically in the page and in a test.
//
// The six tools ship gzipped for the same reason the AVR ones do: the tree is
// smaller than the decompressed bytes, and the decompression is already a cost
// the loader pays.

import { gunzip } from "./tar.js";

export function createArmAssets({ load, importModule }) {
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

  return {
    readAsset,
    readWasm: readAsset,
    importModule,
  };
}
