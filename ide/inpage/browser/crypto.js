// `crypto` for the three things the IDE needs from it: random bytes, a random
// UUID, and a synchronous digest. The browser's own `crypto.getRandomValues` is
// a real CSPRNG, so that half is not a weaker substitute -- it is the same source
// Node uses. The digest half lives in `./hash`, because WebCrypto's is async and
// the IDE's `getId` reads its result inline.
const { createHash } = require("./hash");

function randomBytes(size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function randomUUID() {
  return globalThis.crypto.randomUUID();
}

function getRandomValues(array) {
  return globalThis.crypto.getRandomValues(array);
}

module.exports = {
  randomBytes,
  randomUUID,
  getRandomValues,
  createHash,
  webcrypto: typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto,
};
