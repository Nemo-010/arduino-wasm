// A drop-in for `glob`.
//
// `SketchesServiceImpl` is the only caller, and it asks for exactly two
// patterns:
//
//   /!(libraries|hardware)/**/*.{ino,pde}   with { root }
//   /*.{ino,pde}                            with { root }
//
// The first is the sketchbook scan: every `.ino`/`.pde` below `root`, skipping
// the `libraries` and `hardware` trees. Rather than pull a stream-based glob
// implementation (and its url/stream/minipass polyfills) into the page, this
// walks the page's own filesystem -- the same one the rest of the IDE reads.
//
// A pattern outside those two shapes is refused by name. Silently returning no
// matches would look like an empty sketchbook.

const path = require("path");
const fs = require("./fs.js");

const SKETCH_EXTENSIONS = [".ino", ".pde"];
const SKIPPED_DIRECTORIES = new Set(["libraries", "hardware"]);

async function isDirectory(entry) {
  try {
    const stats = await fs.promises.stat(entry);
    return stats.isDirectory();
  } catch (error) {
    // A path that vanished between readdir and stat is simply not a directory.
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

async function walk(directory, out) {
  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    const child = path.join(directory, name);
    const directoryEntry = typeof entry === "string" ? await isDirectory(child) : entry.isDirectory();
    if (directoryEntry) {
      await walk(child, out);
      continue;
    }
    if (SKETCH_EXTENSIONS.includes(path.extname(name))) out.push(child);
  }
  return out;
}

async function glob(pattern, options = {}) {
  const root = options.root;
  if (!root) {
    throw new Error("glob: only patterns relative to an explicit { root } are answered in the page (got " + pattern + ")");
  }
  if (pattern === "/*.{ino,pde}") {
    const matches = [];
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch((error) => {
      if (error && error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (!SKETCH_EXTENSIONS.includes(path.extname(name))) continue;
      const isDirectoryEntry = typeof entry === "string" ? await isDirectory(path.join(root, name)) : entry.isDirectory();
      if (!isDirectoryEntry) matches.push(path.join(root, name));
    }
    return matches;
  }
  if (pattern === "/!(libraries|hardware)/**/*.{ino,pde}") {
    const matches = [];
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch((error) => {
      if (error && error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (SKIPPED_DIRECTORIES.has(name)) continue;
      const child = path.join(root, name);
      const isDirectoryEntry = typeof entry === "string" ? await isDirectory(child) : entry.isDirectory();
      if (isDirectoryEntry) await walk(child, matches);
    }
    return matches;
  }
  throw new Error(
    "glob: the page answers only the sketchbook patterns the IDE asks for, not " + pattern,
  );
}

// `glob`'s own export shape is a namespace object; the extension uses `glob`
// and nothing else, so only that is offered.
module.exports = { glob };
