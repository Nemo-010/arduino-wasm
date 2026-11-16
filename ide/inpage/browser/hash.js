'use strict';

// A synchronous digest for the page. The IDE hashes sketch paths and renames
// projects with `crypto.createHash(alg).update(v).digest('hex')`, and that call
// is synchronous by contract, so a WebCrypto (asynchronous) substitute cannot
// answer it. Only the two algorithms the IDE names are implemented, and any
// other name throws with the name in the message.

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

function toBytes(data, encoding) {
  if (typeof data === 'string') {
    const format = (encoding || 'utf8').toLowerCase();
    if (format === 'utf8' || format === 'utf-8') {
      return utf8Bytes(data);
    }
    if (format === 'hex') {
      const out = new Uint8Array(Math.floor(data.length / 2));
      for (let i = 0; i < out.length; i += 1) {
        out[i] = parseInt(data.substr(i * 2, 2), 16);
      }
      return out;
    }
    if (format === 'base64') {
      const binary = atob(data);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    }
    if (format === 'latin1' || format === 'binary' || format === 'ascii') {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) {
        out[i] = data.charCodeAt(i) & 0xff;
      }
      return out;
    }
    throw new Error('Unknown digest input encoding: ' + encoding);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data && data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return utf8Bytes(data);
}

const MASK32 = 0xffffffff;

function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) & MASK32;
}

// --- MD5 (RFC 1321) -------------------------------------------------------

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_CONSTANTS = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) {
  MD5_CONSTANTS[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

function md5(bytes) {
  const padded = pad(bytes, 64, true);
  const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const words = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      words[i] = padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24);
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_CONSTANTS[i] + words[g]) & MASK32;
      const rotated = ((sum << MD5_SHIFTS[i]) | (sum >>> (32 - MD5_SHIFTS[i]))) & MASK32;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) & MASK32;
    }
    state[0] = (state[0] + a) & MASK32;
    state[1] = (state[1] + b) & MASK32;
    state[2] = (state[2] + c) & MASK32;
    state[3] = (state[3] + d) & MASK32;
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i += 1) {
    const word = state[i];
    out[i * 4] = word & 0xff;
    out[i * 4 + 1] = (word >>> 8) & 0xff;
    out[i * 4 + 2] = (word >>> 16) & 0xff;
    out[i * 4 + 3] = (word >>> 24) & 0xff;
  }
  return out;
}

// --- SHA-1 (FIPS 180-4) ---------------------------------------------------

function sha1(bytes) {
  const padded = pad(bytes, 64, false);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      words[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
    }
    for (let i = 16; i < 80; i += 1) {
      words[i] = rotl(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + words[i]) & MASK32;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) & MASK32;
    h1 = (h1 + b) & MASK32;
    h2 = (h2 + c) & MASK32;
    h3 = (h3 + d) & MASK32;
    h4 = (h4 + e) & MASK32;
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((word, i) => {
    out[i * 4] = (word >>> 24) & 0xff;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  });
  return out;
}

// Padding appends 0x80, then zeroes, then the bit length. MD5 writes that length
// little-endian; SHA-1 writes it big-endian.
function pad(bytes, blockSize, littleEndian) {
  const withMarker = bytes.length + 1;
  const blocks = Math.ceil((withMarker + 8) / blockSize);
  const out = new Uint8Array(blocks * blockSize);
  out.set(bytes);
  out[bytes.length] = 0x80;
  const lengthOffset = out.length - 8;
  const bits = bytes.length * 8;
  const high = Math.floor(bits / 0x100000000);
  const low = bits >>> 0;
  if (littleEndian) {
    out[lengthOffset] = low & 0xff;
    out[lengthOffset + 1] = (low >>> 8) & 0xff;
    out[lengthOffset + 2] = (low >>> 16) & 0xff;
    out[lengthOffset + 3] = (low >>> 24) & 0xff;
    out[lengthOffset + 4] = high & 0xff;
    out[lengthOffset + 5] = (high >>> 8) & 0xff;
  } else {
    out[lengthOffset] = (high >>> 24) & 0xff;
    out[lengthOffset + 1] = (high >>> 16) & 0xff;
    out[lengthOffset + 2] = (high >>> 8) & 0xff;
    out[lengthOffset + 3] = high & 0xff;
    out[lengthOffset + 4] = (low >>> 24) & 0xff;
    out[lengthOffset + 5] = (low >>> 16) & 0xff;
    out[lengthOffset + 6] = (low >>> 8) & 0xff;
    out[lengthOffset + 7] = low & 0xff;
  }
  return out;
}

const ALGORITHMS = {
  md5: { width: 16, compute: md5 },
  sha1: { width: 20, compute: sha1 },
};

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return out;
}

/**
 * The `Hash` half of Node's `crypto.createHash`, synchronously. Data given to
 * `update` is buffered and digested once in `digest`, which is what Node does
 * for a caller that never reads intermediate state.
 */
function createHash(algorithm) {
  const name = String(algorithm).toLowerCase().replace(/-/g, '');
  const spec = ALGORITHMS[name];
  if (!spec) {
    throw new Error(
      "crypto.createHash('" + algorithm + "') is not implemented in the page; " +
      'only ' + Object.keys(ALGORITHMS).join(' and ') + ' are'
    );
  }
  const chunks = [];
  let finished = false;
  return {
    update(data, encoding) {
      if (finished) {
        throw new Error('crypto.Hash: digest() already called');
      }
      chunks.push(toBytes(data, encoding));
      return this;
    },
    digest(encoding) {
      if (finished) {
        throw new Error('crypto.Hash: digest() already called');
      }
      finished = true;
      let total = 0;
      for (const chunk of chunks) {
        total += chunk.length;
      }
      const joined = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.length;
      }
      const hash = spec.compute(joined);
      if (!encoding) {
        return hash;
      }
      const format = String(encoding).toLowerCase();
      if (format === 'hex') {
        return toHex(hash);
      }
      if (format === 'base64') {
        let binary = '';
        for (let i = 0; i < hash.length; i += 1) {
          binary += String.fromCharCode(hash[i]);
        }
        return btoa(binary);
      }
      if (format === 'latin1' || format === 'binary') {
        let binary = '';
        for (let i = 0; i < hash.length; i += 1) {
          binary += String.fromCharCode(hash[i]);
        }
        return binary;
      }
      throw new Error('Unknown digest output encoding: ' + encoding);
    },
  };
}

module.exports = { createHash, md5: (data) => md5(toBytes(data)), sha1: (data) => sha1(toBytes(data)) };
