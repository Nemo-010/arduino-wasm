// Helpers shared by the toolchain drivers.
//
// A driver here answers arduino-cli's exec seam: it receives a command line the
// platform's recipe produced and has to do what the real tool would have done.
// The two drivers (AVR and ARM) differ in their toolchain and agree on the
// bookkeeping: splitting a command line into flags and operands, writing files
// into a wasm tool's filesystem, and reading an ELF section table to answer the
// `size` recipe. Those live here so a fix lands in both.

export function basename(path) {
  const parts = String(path).split("/");
  return parts[parts.length - 1];
}

// A flag that takes its value as the next argument, rather than joined with `=`
// or attached directly, has to be recorded as one token or its value is read as
// an input file. Which flags those are is the driver's business, so the set is
// passed in rather than assumed.
export function parseArgs(argv, valueFlags) {
  const tokens = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueFlags.has(arg) && index + 1 < argv.length) {
      tokens.push({ flag: arg, value: argv[index + 1] });
      index += 1;
    } else if (arg.startsWith("-")) {
      tokens.push({ flag: arg });
    } else {
      tokens.push({ operand: arg });
    }
  }
  return tokens;
}

export function operands(tokens) {
  return tokens.filter((token) => token.operand !== undefined).map((token) => token.operand);
}

export function flagValue(tokens, name) {
  for (const token of tokens) {
    if (token.flag === name) return token.value;
  }
  return null;
}

export function flagValues(tokens, name) {
  return tokens.filter((token) => token.flag === name).map((token) => token.value);
}

export function joinedValue(tokens, prefix) {
  for (const token of tokens) {
    if (token.flag && token.flag.startsWith(prefix)) return token.flag.slice(prefix.length);
  }
  return null;
}

export function hasFlag(tokens, name) {
  return tokens.some((token) => token.flag === name);
}

export function mkdirp(FS, path) {
  if (!path || path === "/" || path === "") return;
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    try {
      FS.mkdir(current);
    } catch (error) {
      // EEXIST is the normal case: the directory is already there.
      if (error && error.errno !== 20) throw error;
    }
  }
}

// Creates the directory a file lives in. Named for what the caller means: the
// path passed in is a file, so the last segment is not created as a directory.
// (The ARM driver and the AVR driver each grew their own copy of this slice, and
// the copy in `web/arm-tools.js` was called `mkdirp`, which is the *other*
// helper below: it creates the path it is given.)
export function ensureParent(FS, path) {
  const parent = path ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parent) mkdirp(FS, parent);
}

export function writeFile(FS, path, data) {
  ensureParent(FS, path);
  FS.writeFile(path, data);
}

export function readFileIfAny(FS, path) {
  try {
    if (!FS.analyzePath(path).exists) return null;
    return FS.readFile(path, { encoding: "binary" });
  } catch (error) {
    return null;
  }
}

// ELF32 little-endian section table, for the size stand-in. The size recipe only
// needs each section's name, address and size; the CLI sums what its regex
// matches. SHT_NOBITS (.bss) is reported too, because a recipe's regex asks for
// it by name even though it occupies no file bytes.
export function elfSections(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 52 || view.getUint32(0, true) !== 0x464c457f) return null;
  const sectionOffset = view.getUint32(0x20, true);
  const sectionSize = view.getUint16(0x2e, true);
  const sectionCount = view.getUint16(0x30, true);
  const stringIndex = view.getUint16(0x32, true);
  if (!sectionOffset || !sectionCount || sectionSize < 40) return null;

  const header = (index) => sectionOffset + index * sectionSize;
  const stringsHeader = header(stringIndex);
  const stringsOffset = view.getUint32(stringsHeader + 0x10, true);
  const stringsSize = view.getUint32(stringsHeader + 0x14, true);
  const strings = bytes.subarray(stringsOffset, stringsOffset + stringsSize);

  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const at = header(index);
    const nameOffset = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const address = view.getUint32(at + 0x0c, true);
    const size = view.getUint32(at + 0x14, true);
    // A section with no file bytes is still sized, and a recipe asks for .bss
    // by name, so SHT_NOBITS (8) is reported like any other. The null entry at
    // index 0 has no name and is dropped below.
    let end = nameOffset;
    while (end < strings.length && strings[end] !== 0) end += 1;
    const name = new TextDecoder().decode(strings.subarray(nameOffset, end));
    if (!name) continue;
    sections.push({ name, address, size });
  }
  return sections;
}

// Emscripten decides at instantiation whether it is running under Node, and
// its Node branch starts with `await import("module")` — a bare specifier no
// browser can resolve. The page's `process` is deliberately Node-like, because
// the IDE bundle reads `process.versions.node`, so the tools are told the truth
// for the length of one instantiation instead: hide the version, call the
// factory, put it back.
//
// The flag is read once, synchronously, before the factory's first await, so
// the property only has to be gone while the call starts. Tool instances are
// created one at a time per driver, so two tools never race for this.
export async function createToolInstance(create, options) {
  const host = typeof process === "object" && process ? process : null;
  const had = host !== null && Object.prototype.hasOwnProperty.call(host, "versions");
  const saved = had ? host.versions : undefined;
  try {
    if (had) delete host.versions;
    return await create(options);
  } finally {
    if (had) host.versions = saved;
  }
}
