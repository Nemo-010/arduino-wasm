// A Node-style filesystem for Go's js/wasm runtime, backed by browser storage.
//
// Go's syscall package for js/wasm implements os.* by calling the Node fs API
// found at globalThis.fs. Every one of those calls is callback-based, so this
// shim can be fully asynchronous internally: Go blocks a goroutine, not the
// JavaScript event loop. That is what lets IndexedDB (which has no synchronous
// API) hold the files.
//
// The tree is a plain POSIX namespace: paths and bytes. Nothing about Arduino
// is modelled here. arduino-cli creates directories, extracts archives and
// writes index files exactly as it does on a desktop; this file only decides
// where those bytes live.

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;

const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 0x40;
const O_EXCL = 0x80;
const O_TRUNC = 0x200;
const O_APPEND = 0x400;
const O_DIRECTORY = 0x10000;

// Node's fs errors carry a numeric `errno` beside the string `code`, and code
// written against Node checks both: the IDE's `ErrnoException.is()` requires
// `code` to be a string *and* `errno` to be a number before it will look at
// either. An error with only `code` is therefore not an ENOENT to that code,
// which is how a missing config file became a silent hang instead of a create.
//
// These are the values libuv reports on Linux, which is what Node prints.
export const ERRNO = {
  EPERM: -1,
  ENOENT: -2,
  EIO: -5,
  EBADF: -9,
  EACCES: -13,
  EBUSY: -16,
  EEXIST: -17,
  EXDEV: -18,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  EMFILE: -24,
  ENOSPC: -28,
  EROFS: -30,
  EPIPE: -32,
  ENAMETOOLONG: -36,
  ENOSYS: -38,
  ENOTEMPTY: -39,
  ELOOP: -40,
  ETIMEDOUT: -110,
};

export function fsError(code, path, syscall) {
  const error = new Error(code + (path ? ": " + path : ""));
  error.code = code;
  // A code outside the table would report the wrong number, so it is a defect
  // in this file rather than in the caller; `test/run.mjs` checks every code
  // used here is in the table.
  error.errno = Object.prototype.hasOwnProperty.call(ERRNO, code) ? ERRNO[code] : -1;
  if (syscall) error.syscall = syscall;
  if (path) error.path = path;
  return error;
}

class Stat {
  constructor(kind, size, mode, mtime) {
    this.dev = 0;
    this.ino = 1;
    this.mode = (kind === "dir" ? S_IFDIR : kind === "link" ? S_IFLNK : S_IFREG) | (mode & 0o7777);
    this.nlink = 1;
    this.uid = 1000;
    this.gid = 1000;
    this.rdev = 0;
    this.size = size;
    this.blksize = 4096;
    this.blocks = Math.ceil(size / 512);
    this.atimeMs = mtime;
    this.mtimeMs = mtime;
    this.ctimeMs = mtime;
  }
  isDirectory() {
    return (this.mode & S_IFMT) === S_IFDIR;
  }
  isFile() {
    return (this.mode & S_IFMT) === S_IFREG;
  }
  isSymbolicLink() {
    return (this.mode & S_IFMT) === S_IFLNK;
  }
}

function charDevice() {
  // stdout and stderr: a character device with no size.
  return new Stat("file", 0, 0o622, Date.now());
}

function normalize(path, cwd) {
  let value = String(path);
  if (!value.startsWith("/")) {
    value = cwd + "/" + value;
  }
  const parts = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function dirname(path) {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function joinPath(base, rest) {
  if (rest.startsWith("/")) return rest;
  return base === "/" ? "/" + rest : base + "/" + rest;
}

function sleepScheduler(callback) {
  // Never call back on the same stack: Go's fsCall waits on a channel and
  // expects the callback to run after the JS frame unwinds.
  queueMicrotask(callback);
}

class MemoryBackend {
  constructor() {
    this.records = new Map();
  }
  async get(path) {
    return this.records.get(path) || null;
  }
  async put(path, record) {
    this.records.set(path, record);
  }
  async del(path) {
    this.records.delete(path);
  }
  async children(path) {
    const prefix = path === "/" ? "/" : path + "/";
    const names = [];
    for (const key of this.records.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes("/")) names.push(rest);
    }
    return names;
  }
  async keys() {
    return [...this.records.keys()];
  }
  async movePrefix(from, to) {
    const prefix = from + "/";
    const moves = [];
    for (const [key, record] of this.records) {
      if (key.startsWith(prefix)) moves.push([key, to + key.slice(from.length), record]);
    }
    for (const [key] of moves) this.records.delete(key);
    for (const [, key, record] of moves) this.records.set(key, record);
  }
  async clear() {
    this.records.clear();
  }

  // The synchronous view. The IDE's Node modules call `fs.readFileSync` and
  // friends, so the page's filesystem has to answer without awaiting -- which
  // means the working set has to be in memory. It already is.
  getSync(path) {
    return this.records.get(path) || null;
  }
  putSync(path, record) {
    this.records.set(path, record);
  }
  delSync(path) {
    this.records.delete(path);
  }
  childrenSync(path) {
    const prefix = path === "/" ? "/" : path + "/";
    const names = [];
    for (const key of this.records.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes("/")) names.push(rest);
    }
    return names;
  }
  keysSync() {
    return [...this.records.keys()];
  }
}

// Keeps the whole tree in memory and writes each change through to a slower
// backend, so `fs.*Sync` has something to read. IndexedDB is asynchronous by
// nature; a synchronous API over it is only possible against a hydrated copy,
// and a hydrated copy is what the page needs anyway for its size.
class CachedBackend {
  constructor(inner) {
    this.inner = inner;
    this.records = new Map();
    this.pending = Promise.resolve();
  }

  async hydrate() {
    for (const key of await this.inner.keys()) {
      this.records.set(key, await this.inner.get(key));
    }
    return this.records.size;
  }

  // Reads answer from the mirror: it is the same data, and a read waiting on a
  // disk that has already been read is time spent for nothing.
  async get(path) {
    return this.getSync(path);
  }
  async children(path) {
    return this.childrenSync(path);
  }
  async keys() {
    return this.keysSync();
  }
  async put(path, record) {
    this.putSync(path, record);
    this.pending = this.pending.then(() => this.inner.put(path, record)).catch(() => undefined);
    return this.pending;
  }
  async del(path) {
    this.delSync(path);
    this.pending = this.pending.then(() => this.inner.del(path)).catch(() => undefined);
    return this.pending;
  }

  getSync(path) {
    if (path === "/") return { kind: "dir", mode: 0o755, mtime: 0 };
    return this.records.get(path) || null;
  }
  putSync(path, record) {
    this.records.set(path, record);
  }
  delSync(path) {
    this.records.delete(path);
  }
  childrenSync(path) {
    const prefix = path === "/" ? "/" : path + "/";
    const names = [];
    for (const key of this.records.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes("/")) names.push(rest);
    }
    return names;
  }
  keysSync() {
    return [...this.records.keys()];
  }

  async movePrefix(from, to) {
    const prefix = from + "/";
    const moves = [];
    for (const [key, record] of this.records) {
      if (key.startsWith(prefix)) moves.push([key, to + key.slice(from.length), record]);
    }
    for (const [key] of moves) this.records.delete(key);
    for (const [, key, record] of moves) this.records.set(key, record);
    this.pending = this.pending.then(() => this.inner.movePrefix(from, to)).catch(() => undefined);
    return this.pending;
  }

  async clear() {
    this.records.clear();
    this.pending = this.pending.then(() => this.inner.clear()).catch(() => undefined);
    return this.pending;
  }

  async flush() {
    return this.pending;
  }
}

class IdbBackend {
  constructor(name = "arduino-wasm") {
    this.name = name;
    this.store = "files";
    this.dbPromise = this.openDatabase();
  }
  openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async transaction(mode, body) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, mode);
      const store = tx.objectStore(this.store);
      let result;
      try {
        result = body(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  }
  async get(path) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const request = db.transaction(this.store).objectStore(this.store).get(path);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async put(path, record) {
    await this.transaction("readwrite", (store) => store.put(record, path));
  }
  async del(path) {
    await this.transaction("readwrite", (store) => store.delete(path));
  }
  async children(path) {
    const prefix = path === "/" ? "/" : path + "/";
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const request = db.transaction(this.store).objectStore(this.store)
        .getAllKeys(IDBKeyRange.bound(prefix, prefix + "\uffff"));
      request.onsuccess = () => {
        const names = [];
        for (const key of request.result) {
          const rest = key.slice(prefix.length);
          if (rest && !rest.includes("/")) names.push(rest);
        }
        resolve(names);
      };
      request.onerror = () => reject(request.error);
    });
  }
  async keys() {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const request = db.transaction(this.store).objectStore(this.store).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async movePrefix(from, to) {
    const prefix = from + "/";
    const db = await this.dbPromise;
    const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readwrite");
      const store = tx.objectStore(this.store);
      const moves = [];
      const cursor = store.openCursor(range);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current) {
          moves.push([current.key, current.value]);
          current.continue();
          return;
        }
        for (const [key, value] of moves) {
          store.put(value, to + key.slice(from.length));
          store.delete(key);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  }
  async clear() {
    await this.transaction("readwrite", (store) => store.clear());
  }
}

export async function deleteDatabase(name = "arduino-wasm") {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

export function createNodeFS(options = {}) {
  // A synchronous `fs` needs a synchronous view of the tree. IndexedDB cannot
  // answer without awaiting, so it is wrapped in a backend that keeps the tree
  // in memory and writes each change through. The working set is the same data;
  // the wrapper only decides who waits.
  let backend = options.backend || new MemoryBackend();
  if (typeof backend.getSync !== "function") backend = new CachedBackend(backend);
  const stdout = options.stdout || ((text) => console.log(text));
  const stderr = options.stderr || ((text) => console.error(text));
  const cwd = { value: options.cwd || "/" };
  // Character devices are paths a native tool can open (`/dev/ttyACM0`) whose
  // bytes come from a WebSerial port instead of a file. One mechanism serves
  // every upload tool: the tool's own platform recipe decides what to write.
  const devices = options.devices || new Map();

  const fds = new Map();
  let nextFd = 3;
  const decoder = new TextDecoder();

  async function entryAt(path) {
    if (path === "/") {
      return { kind: "dir", mode: 0o755, mtime: 0 };
    }
    const device = devices.get(path);
    if (device) return { kind: "device", mode: 0o666, mtime: 0, device };
    return backend.get(path);
  }

  // Resolve a path, expanding symlinks. followLast=false gives lstat semantics.
  async function resolve(path, followLast = true, allowMissing = false, depth = 0) {
    if (depth > 32) throw fsError("ELOOP", path);
    let current = "/";
    const parts = normalize(path, cwd.value).split("/").filter(Boolean);
    // A registered device is a leaf even when /dev was never created in the
    // tree; skip the directory walk for it.
    if (devices.has("/" + parts.join("/"))) return "/" + parts.join("/");
    for (let i = 0; i < parts.length; i++) {
      const next = current === "/" ? "/" + parts[i] : current + "/" + parts[i];
      const entry = await entryAt(next);
      const isLast = i === parts.length - 1;
      if (!entry) {
        if (isLast && allowMissing) return next;
        throw fsError("ENOENT", path);
      }
      if (entry.kind === "link" && (!isLast || followLast)) {
        const target = joinPath(dirname(next), entry.target);
        const rest = parts.slice(i + 1).join("/");
        return resolve(rest ? target + "/" + rest : target, followLast, allowMissing, depth + 1);
      }
      if (!isLast && entry.kind !== "dir") throw fsError("ENOTDIR", path);
      current = next;
    }
    return current;
  }

  async function requireEntry(path, followLast = true) {
    const resolved = await resolve(path, followLast);
    const entry = await entryAt(resolved);
    if (!entry) throw fsError("ENOENT", path);
    return [resolved, entry];
  }


  // The synchronous mirror of the two helpers above. Every sync call goes
  // through these, so a symlink means the same thing whether the caller awaited.
  function entryAtSync(path) {
    if (path === "/") return { kind: "dir", mode: 0o755, mtime: 0 };
    return backend.getSync(path);
  }

  function resolveSync(path, followLast = true, allowMissing = false, depth = 0) {
    if (depth > 32) throw fsError("ELOOP", path);
    let current = "/";
    const parts = normalize(path, cwd.value).split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const next = current === "/" ? "/" + parts[i] : current + "/" + parts[i];
      const entry = entryAtSync(next);
      const isLast = i === parts.length - 1;
      if (!entry) {
        if (isLast && allowMissing) return next;
        throw fsError("ENOENT", path);
      }
      if (entry.kind === "link" && (!isLast || followLast)) {
        const target = joinPath(dirname(next), entry.target);
        const rest = parts.slice(i + 1).join("/");
        return resolveSync(rest ? target + "/" + rest : target, followLast, allowMissing, depth + 1);
      }
      if (!isLast && entry.kind !== "dir") throw fsError("ENOTDIR", path);
      current = next;
    }
    return current;
  }

  function requireEntrySync(path, followLast = true) {
    const resolved = resolveSync(path, followLast);
    const entry = entryAtSync(resolved);
    if (!entry) throw fsError("ENOENT", path);
    return [resolved, entry];
  }

  // Bytes in, bytes out. A string is UTF-8, because that is what every writer
  // in the IDE means when it hands the filesystem a string.
  function toBytes(data) {
    if (typeof data === "string") return new TextEncoder().encode(data);
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  function fromBytes(data) {
    // Node callers expect a Buffer; a page has one only if the bundle installed
    // the polyfill. Returning the bytes themselves when it has not keeps the
    // failure at the caller's `toString("utf8")` instead of here.
    return typeof Buffer !== "undefined" && typeof Buffer.from === "function" ? Buffer.from(data) : data;
  }

  function writeFileSyncAt(path, data, mode) {
    const resolved = resolveSync(path, true, true);
    const existing = entryAtSync(resolved);
    if (existing && existing.kind === "dir") throw fsError("EISDIR", path);
    const parent = entryAtSync(dirname(resolved));
    if (!parent) throw fsError("ENOENT", path);
    if (parent.kind !== "dir") throw fsError("ENOTDIR", path);
    backend.putSync(resolved, {
      kind: "file",
      data: toBytes(data),
      mode: MODE_FILE(mode !== undefined ? mode : existing ? existing.mode : undefined),
      mtime: Date.now(),
    });
    return null;
  }

  async function writeFileAt(path, data, mode) {
    const resolved = await resolve(path, true, true);
    const existing = await entryAt(resolved);
    if (existing && existing.kind === "dir") throw fsError("EISDIR", path);
    const parent = await entryAt(dirname(resolved));
    if (!parent) throw fsError("ENOENT", path);
    if (parent.kind !== "dir") throw fsError("ENOTDIR", path);
    await backend.put(resolved, {
      kind: "file",
      data: toBytes(data),
      mode: MODE_FILE(mode !== undefined ? mode : existing ? existing.mode : undefined),
      mtime: Date.now(),
    });
    return null;
  }

  function readFileSyncAt(path) {
    const [, entry] = requireEntrySync(path);
    if (entry.kind === "dir") throw fsError("EISDIR", path);
    if (entry.kind !== "file") throw fsError("EINVAL", path);
    return fromBytes(entry.data || new Uint8Array(0));
  }

  async function readFileAt(path) {
    const [, entry] = await requireEntry(path);
    if (entry.kind === "dir") throw fsError("EISDIR", path);
    if (entry.kind !== "file") throw fsError("EINVAL", path);
    return fromBytes(entry.data || new Uint8Array(0));
  }

  // `recursive` is how the IDE creates a sketch directory, a config directory
  // and a build directory: parents first, no error if it is already there.
  function mkdirSyncAt(path, options) {
    const recursive = !!(options && typeof options === "object" ? options.recursive : false);
    const mode = options && typeof options === "object" ? options.mode : options;
    if (!recursive) {
      const resolved = resolveSync(path, true, true);
      if (entryAtSync(resolved)) throw fsError("EEXIST", path);
      const parent = entryAtSync(dirname(resolved));
      if (!parent) throw fsError("ENOENT", path);
      if (parent.kind !== "dir") throw fsError("ENOTDIR", path);
      backend.putSync(resolved, { kind: "dir", mode: MODE_DIR(mode), mtime: Date.now() });
      return undefined;
    }
    const parts = normalize(path, cwd.value).split("/").filter(Boolean);
    let current = "/";
    for (const part of parts) {
      current = current === "/" ? "/" + part : current + "/" + part;
      const entry = entryAtSync(current);
      if (entry) {
        if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
        continue;
      }
      backend.putSync(current, { kind: "dir", mode: MODE_DIR(mode), mtime: Date.now() });
    }
    return undefined;
  }

  async function mkdirAt(path, options) {
    const recursive = !!(options && typeof options === "object" ? options.recursive : false);
    const mode = options && typeof options === "object" ? options.mode : options;
    if (!recursive) {
      const resolved = await resolve(path, true, true);
      if (await entryAt(resolved)) throw fsError("EEXIST", path);
      const parent = await entryAt(dirname(resolved));
      if (!parent) throw fsError("ENOENT", path);
      if (parent.kind !== "dir") throw fsError("ENOTDIR", path);
      await backend.put(resolved, { kind: "dir", mode: MODE_DIR(mode), mtime: Date.now() });
      return undefined;
    }
    const parts = normalize(path, cwd.value).split("/").filter(Boolean);
    let current = "/";
    for (const part of parts) {
      current = current === "/" ? "/" + part : current + "/" + part;
      const entry = await entryAt(current);
      if (entry) {
        if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
        continue;
      }
      await backend.put(current, { kind: "dir", mode: MODE_DIR(mode), mtime: Date.now() });
    }
    return undefined;
  }

  // Which names a directory holds. `withFileTypes` is what glob and the IDE's
  // project tree ask for, and a Dirent is three fields.
  function dirents(path, entries, withFileTypes) {
    if (!withFileTypes) return entries.map((entry) => entry.name);
    return entries.map((entry) => ({
      name: entry.name,
      parentPath: path,
      path,
      isFile: () => entry.kind === "file",
      isDirectory: () => entry.kind === "dir",
      isSymbolicLink: () => entry.kind === "link",
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    }));
  }

  function readdirSyncAt(path, options) {
    const [resolved, entry] = requireEntrySync(path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
    const withFileTypes = !!(options && typeof options === "object" && options.withFileTypes);
    const names = backend.childrenSync(resolved);
    const entries = names.map((name) => {
      const child = resolved === "/" ? "/" + name : resolved + "/" + name;
      return { name, kind: (entryAtSync(child) || { kind: "file" }).kind };
    });
    return dirents(path, entries, withFileTypes);
  }

  async function readdirAt(path, options) {
    const [resolved, entry] = await requireEntry(path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
    const withFileTypes = !!(options && typeof options === "object" && options.withFileTypes);
    const names = await backend.children(resolved);
    const entries = [];
    for (const name of names) {
      const child = resolved === "/" ? "/" + name : resolved + "/" + name;
      entries.push({ name, kind: ((await entryAt(child)) || { kind: "file" }).kind });
    }
    return dirents(path, entries, withFileTypes);
  }

  function callback(cb, promise) {
    promise.then(
      (value) => sleepScheduler(() => cb(null, value === undefined ? null : value)),
      (error) => sleepScheduler(() => {
        // Go's js syscall maps the error through a fixed errno table and
        // panics on anything else, so every error must carry a known code.
        const known = error && typeof error.code === "string";
        if (!known) {
          const wrapped = fsError("EIO");
          wrapped.cause = error;
          if (options.debug) console.error("shim: error without errno code:", error);
          cb(wrapped);
          return;
        }
        cb(error);
      }),
    );
  }

  function flushFd(fd) {
    const file = fds.get(fd);
    if (!file || file.kind !== "file" || !file.dirty) return Promise.resolve();
    file.dirty = false;
    return backend.put(file.path, {
      kind: "file",
      data: file.data,
      mode: file.mode,
      mtime: file.mtime,
    });
  }

  const MODE_FILE = (value) => (value === undefined ? 0o666 : value & 0o7777);
  const MODE_DIR = (value) => (value === undefined ? 0o777 : value & 0o7777);

  // Go passes numeric flags, but the shim is also used directly by the page and
  // by the tests, where "w" is the obvious thing to write. A string flag that
  // reaches the numeric checks would silently mean O_RDONLY and turn a create
  // into ENOENT.
  const FLAGS_BY_NAME = {
    r: O_RDONLY,
    "r+": O_RDWR,
    w: O_WRONLY | O_CREAT | O_TRUNC,
    "w+": O_RDWR | O_CREAT | O_TRUNC,
    a: O_WRONLY | O_CREAT | O_APPEND,
    "a+": O_RDWR | O_CREAT | O_APPEND,
  };

  function flagBits(flags) {
    if (flags === undefined) return O_RDONLY;
    if (typeof flags !== "string") return flags;
    const bits = FLAGS_BY_NAME[flags];
    if (bits === undefined) throw fsError("EINVAL", "flags: " + flags);
    return bits;
  }

  const fs = {
    // The Go runtime itself (panic output, runtime.print) writes to fd 1/2
    // through this synchronous hook rather than the syscall path.
    writeSync(fd, buffer) {
      const text = decoder.decode(buffer);
      (fd === 2 ? stderr : stdout)(text);
      return buffer.length;
    },

    readSync(fd, buffer) {
      return 0;
    },

    // ---- the synchronous surface -------------------------------------------
    //
    // The IDE's Node modules were written against a filesystem that answers in
    // the same tick: `fs.readFileSync` while a module loads, `fs.mkdirSync` for a
    // build directory, `fs.realpathSync` for the temporary directory. The tree
    // is in memory, so every one of these is a lookup.

    readFileSync(path, options) {
      const data = readFileSyncAt(path);
      const encoding = typeof options === "string" ? options : options && options.encoding;
      return encoding ? data.toString(encoding) : data;
    },
    writeFileSync(path, data, options) {
      const mode = options && typeof options === "object" ? options.mode : undefined;
      writeFileSyncAt(path, data, mode);
    },
    appendFileSync(path, data, options) {
      let existing = new Uint8Array(0);
      try {
        existing = toBytes(readFileSyncAt(path));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const added = toBytes(data);
      const merged = new Uint8Array(existing.length + added.length);
      merged.set(existing, 0);
      merged.set(added, existing.length);
      const mode = options && typeof options === "object" ? options.mode : undefined;
      writeFileSyncAt(path, merged, mode);
    },
    mkdirSync(path, options) {
      const mode = options && typeof options === "object" ? options.mode : options;
      return mkdirSyncAt(path, options === undefined ? undefined : { ...(typeof options === "object" ? options : {}), mode });
    },
    readdirSync(path, options) {
      return readdirSyncAt(path, options);
    },
    statSync(path) {
      const [, entry] = requireEntrySync(path);
      return new Stat(entry.kind, entry.kind === "file" ? (entry.data || new Uint8Array(0)).length : 0, entry.mode, entry.mtime);
    },
    lstatSync(path) {
      const [, entry] = requireEntrySync(path, false);
      return new Stat(entry.kind, entry.kind === "file" ? (entry.data || new Uint8Array(0)).length : 0, entry.mode, entry.mtime);
    },
    existsSync(path) {
      try {
        return !!entryAtSync(resolveSync(path));
      } catch (_error) {
        return false;
      }
    },
    realpathSync: Object.assign(
      (path) => resolveSync(path),
      { native: (path) => resolveSync(path) },
    ),
    unlinkSync(path) {
      const [resolved, entry] = requireEntrySync(path, false);
      if (entry.kind === "dir") throw fsError("EISDIR", path);
      backend.delSync(resolved);
    },
    rmdirSync(path, options) {
      const [resolved, entry] = requireEntrySync(path, false);
      if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
      if (resolved === "/") throw fsError("EBUSY", path);
      const children = backend.childrenSync(resolved);
      if (children.length > 0) {
        if (!(options && options.recursive)) throw fsError("ENOTEMPTY", path);
        for (const key of backend.keysSync()) {
          if (key === resolved || key.startsWith(resolved + "/")) backend.delSync(key);
        }
        return;
      }
      backend.delSync(resolved);
    },
    renameSync(from, to) {
      const [resolvedFrom, entry] = requireEntrySync(from, false);
      const resolvedTo = resolveSync(to, true, true);
      backend.delSync(resolvedFrom);
      backend.putSync(resolvedTo, entry);
      for (const key of backend.keysSync()) {
        if (key.startsWith(resolvedFrom + "/")) {
          backend.putSync(resolvedTo + key.slice(resolvedFrom.length), backend.getSync(key));
          backend.delSync(key);
        }
      }
    },
    copyFileSync(from, to) {
      const [, entry] = requireEntrySync(from);
      if (entry.kind === "dir") throw fsError("EISDIR", from);
      writeFileSyncAt(to, entry.data || new Uint8Array(0), entry.mode);
    },
    chmodSync(path, mode) {
      const [resolved, entry] = requireEntrySync(path, false);
      backend.putSync(resolved, { ...entry, mode: mode & 0o7777 });
    },
    accessSync(path, _mode) {
      requireEntrySync(path);
    },
    readlinkSync(path) {
      const [, entry] = requireEntrySync(path, false);
      if (entry.kind !== "link") throw fsError("EINVAL", path);
      return entry.target;
    },
    symlinkSync(target, path) {
      const resolved = resolveSync(path, true, true);
      backend.putSync(resolved, { kind: "link", target: String(target), mode: 0o777, mtime: Date.now() });
    },
    truncateSync(path, length = 0) {
      const [resolved, entry] = requireEntrySync(path);
      if (entry.kind === "dir") throw fsError("EISDIR", path);
      const data = new Uint8Array(length);
      data.set((entry.data || new Uint8Array(0)).subarray(0, length));
      backend.putSync(resolved, { ...entry, data, mtime: Date.now() });
    },
    utimesSync(path, atime, mtime) {
      const [resolved, entry] = requireEntrySync(path);
      const when = mtime instanceof Date ? mtime.getTime() : Date.now();
      backend.putSync(resolved, { ...entry, mtime: when });
    },

    // ---- the callback surface the IDE also uses ----------------------------

    // Node's `fs.realpath` carries a `.native` twin, and callers reach for it
    // by name (`node_fs_1.realpath.native`); a function without the property
    // throws a TypeError the caller never expects.
    realpath: Object.assign(
      (path, cb) => {
        callback(cb, (async () => resolve(path))());
      },
      {
        native: (path, cb) => {
          callback(cb, (async () => resolve(path))());
        },
      },
    ),
    readFile(path, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      callback(cb, (async () => {
        const data = await readFileAt(path);
        const encoding = typeof options === "string" ? options : options && options.encoding;
        return encoding ? data.toString(encoding) : data;
      })());
    },
    writeFile(path, data, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      const mode = options && typeof options === "object" ? options.mode : undefined;
      callback(cb, writeFileAt(path, data, mode));
    },
    appendFile(path, data, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      const mode = options && typeof options === "object" ? options.mode : undefined;
      callback(cb, (async () => {
        let existing = new Uint8Array(0);
        try {
          existing = toBytes(await readFileAt(path));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const added = toBytes(data);
        const merged = new Uint8Array(existing.length + added.length);
        merged.set(existing, 0);
        merged.set(added, existing.length);
        return writeFileAt(path, merged, mode);
      })());
    },
    copyFile(from, to, cb) {
      callback(cb, (async () => {
        const [, entry] = await requireEntry(from);
        if (entry.kind === "dir") throw fsError("EISDIR", from);
        return writeFileAt(to, entry.data || new Uint8Array(0), entry.mode);
      })());
    },
    access(path, _mode, cb) {
      callback(cb, (async () => {
        await requireEntry(path);
      })());
    },

    constants: {
      O_RDONLY: 0,
      O_WRONLY,
      O_RDWR,
      O_CREAT,
      O_EXCL,
      O_TRUNC,
      O_APPEND,
      O_DIRECTORY,
    },

    open(path, flags, mode, cb) {
      callback(cb, (async () => {
        flags = flagBits(flags);
        const resolved = await resolve(path, true, true);
        let entry = await entryAt(resolved);
        const creating = (flags & O_CREAT) !== 0;
        if (!entry) {
          if (!creating) throw fsError("ENOENT", path);
          const parent = await entryAt(dirname(resolved));
          if (!parent) throw fsError("ENOENT", path);
          if (parent.kind !== "dir") throw fsError("ENOTDIR", path);
          entry = { kind: "file", data: new Uint8Array(0), mode: MODE_FILE(mode), mtime: Date.now() };
          await backend.put(resolved, entry);
        } else if (creating && (flags & O_EXCL)) {
          throw fsError("EEXIST", path);
        }
        if ((flags & O_DIRECTORY) && entry.kind !== "dir") throw fsError("ENOTDIR", path);
        const writing = (flags & (O_WRONLY | O_RDWR)) !== 0;
        if (entry.kind === "dir" && writing) throw fsError("EISDIR", path);
        if (entry.kind === "link") throw fsError("ENOENT", path);
        if (entry.kind === "device") {
          if (entry.device.open) await entry.device.open();
          const descriptor = { path: resolved, kind: "device", device: entry.device, flags };
          const deviceFd = nextFd++;
          fds.set(deviceFd, descriptor);
          return deviceFd;
        }

        if ((flags & O_TRUNC) && entry.kind === "file") {
          entry = { ...entry, data: new Uint8Array(0), mtime: Date.now() };
          await backend.put(resolved, entry);
        }
        // Files are held in memory while open and written back on close or
        // fsync. A single IndexedDB record per file keeps the model small.
        const file = {
          path: resolved,
          kind: entry.kind,
          data: entry.kind === "file" ? entry.data : null,
          mode: entry.mode,
          mtime: entry.mtime,
          flags,
          offset: 0,
          dirty: false,
        };
        const fd = nextFd++;
        fds.set(fd, file);
        return fd;
      })());
    },

    close(fd, cb) {
      callback(cb, (async () => {
        const file = fds.get(fd);
        if (file && file.kind === "device" && file.device.close) await file.device.close();
        await flushFd(fd);
        fds.delete(fd);
        return null;
      })());
    },

    fstat(fd, cb) {
      callback(cb, (async () => {
        if (fd === 1 || fd === 2) return charDevice();
        if (fd === 0) return new Stat("file", 0, 0o600, Date.now());
        const file = fds.get(fd);
        if (!file) throw fsError("EBADF");
        if (file.kind === "device") return charDevice();
        if (file.kind === "dir") return new Stat("dir", 0, file.mode, file.mtime);
        return new Stat("file", file.data.length, file.mode, file.mtime);
      })());
    },

    stat(path, cb) {
      callback(cb, (async () => {
        const [, entry] = await requireEntry(path);
        const size = entry.kind === "file" ? entry.data.length : entry.kind === "link" ? entry.target.length : 0;
        return new Stat(entry.kind, size, entry.mode, entry.mtime);
      })());
    },

    lstat(path, cb) {
      callback(cb, (async () => {
        const [, entry] = await requireEntry(path, false);
        const size = entry.kind === "file" ? entry.data.length : entry.kind === "link" ? entry.target.length : 0;
        return new Stat(entry.kind, size, entry.mode, entry.mtime);
      })());
    },

    mkdir(path, options, cb) {
      // `fs.mkdir(path, { recursive: true }, cb)` is how the IDE makes a sketch
      // directory. Before this, the options object arrived as a numeric mode and
      // a missing parent produced ENOENT -- a defect the extension hit at boot.
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      callback(cb, mkdirAt(path, options));
    },

    rmdir(path, cb) {
      callback(cb, (async () => {
        const [resolved, entry] = await requireEntry(path);
        if (resolved === "/") throw fsError("EBUSY", path);
        if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
        const children = await backend.children(resolved);
        if (children.length > 0) throw fsError("ENOTEMPTY", path);
        await backend.del(resolved);
        return null;
      })());
    },

    readdir(path, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      callback(cb, readdirAt(path, options));
    },

    unlink(path, cb) {
      callback(cb, (async () => {
        const [resolved, entry] = await requireEntry(path, false);
        if (entry.kind === "dir") throw fsError("EISDIR", path);
        await backend.del(resolved);
        return null;
      })());
    },

    rename(from, to, cb) {
      callback(cb, (async () => {
        const [source, entry] = await requireEntry(from, false);
        const target = await resolve(to, true, true);
        if (source === target) return null;
        if (entry.kind === "dir" && target.startsWith(source + "/")) {
          throw fsError("EINVAL", to);
        }
        const parent = await entryAt(dirname(target));
        if (!parent) throw fsError("ENOENT", to);
        if (parent.kind !== "dir") throw fsError("ENOTDIR", to);
        const existing = await entryAt(target);
        if (existing) {
          if (entry.kind === "dir" || existing.kind === "dir") {
            if (entry.kind !== existing.kind) {
              throw fsError(entry.kind === "dir" ? "ENOTDIR" : "EISDIR", to);
            }
            if ((await backend.children(target)).length > 0) throw fsError("ENOTEMPTY", to);
          }
          if (entry.kind === "dir") await backend.del(target);
        }
        if (entry.kind === "dir" && !target.startsWith(source + "/")) {
          await backend.movePrefix(source, target);
        }
        await backend.put(target, entry);
        await backend.del(source);
        return null;
      })());
    },

    truncate(path, length, cb) {
      callback(cb, (async () => {
        const [resolved, entry] = await requireEntry(path);
        if (entry.kind !== "file") throw fsError("EISDIR", path);
        const data = new Uint8Array(Number(length));
        data.set(entry.data.subarray(0, Math.min(entry.data.length, data.length)));
        await backend.put(resolved, { ...entry, data, mtime: Date.now() });
        for (const open of fds.values()) {
          if (open.path !== resolved) continue;
          open.data = data;
          open.offset = Math.min(open.offset, data.length);
        }
        return null;
      })());
    },

    ftruncate(fd, length, cb) {
      callback(cb, (async () => {
        const file = fds.get(fd);
        if (!file || file.kind !== "file") throw fsError("EBADF");
        const data = new Uint8Array(Number(length));
        data.set(file.data.subarray(0, Math.min(file.data.length, data.length)));
        file.data = data;
        file.offset = Math.min(file.offset, data.length);
        file.dirty = true;
        return null;
      })());
    },

    // termios and baud-rate configuration from a native serial tool land
    // here. A device answers the request; ordinary files have no ioctls.
    ioctl(fd, request, arg, cb) {
      callback(cb, (async () => {
        const file = fds.get(fd);
        if (!file) throw fsError("EBADF");
        if (file.kind === "device" && file.device.ioctl) {
          return file.device.ioctl(request, arg);
        }
        return 0;
      })());
    },

    read(fd, buffer, offset, length, position, cb) {
      callback(cb, (async () => {
        if (fd === 0) return 0;
        const file = fds.get(fd);
        if (!file) throw fsError("EBADF");
        if (file.kind === "device") {
          if (!file.device.read) return 0;
          return file.device.read(buffer, offset, length);
        }
        if (file.kind !== "file") throw fsError("EISDIR");
        const start = position === null || position === undefined ? file.offset : Number(position);
        const end = Math.min(start + length, file.data.length);
        const count = Math.max(0, end - start);
        if (count > 0) {
          buffer.set(file.data.subarray(start, end), offset);
        }
        if (position === null || position === undefined) file.offset = start + count;
        return count;
      })());
    },

    write(fd, buffer, offset, length, position, cb) {
      callback(cb, (async () => {
        if (fd === 1 || fd === 2) {
          const text = decoder.decode(buffer.subarray(offset, offset + length));
          (fd === 2 ? stderr : stdout)(text);
          return length;
        }
        const file = fds.get(fd);
        if (!file) throw fsError("EBADF");
        if (file.kind === "device") {
          if (!file.device.write) return length;
          return file.device.write(buffer, offset, length);
        }
        if (file.kind !== "file") throw fsError("EISDIR");
        const append = (file.flags & O_APPEND) !== 0;
        const start = append
          ? file.data.length
          : position === null || position === undefined
            ? file.offset
            : Number(position);
        const end = start + length;
        if (end > file.data.length) {
          // Grow the capacity geometrically and expose only the written range.
          // Allocating an exact-size buffer per write copies the whole file each
          // time: a 116 MB tarball written in 32 KB chunks copies ~200 GB.
          const storage = file.data.buffer;
          const offset = file.data.byteOffset;
          if (offset + end > storage.byteLength) {
            const grown = new Uint8Array(Math.max(end, storage.byteLength * 2));
            grown.set(file.data);
            file.data = grown.subarray(0, end);
          } else {
            file.data = new Uint8Array(storage, offset, end);
          }
        }
        file.data.set(buffer.subarray(offset, offset + length), start);
        if (append || position === null || position === undefined) file.offset = end;
        file.mtime = Date.now();
        file.dirty = true;
        return length;
      })());
    },

    chmod(path, mode, cb) {
      callback(cb, (async () => {
        const [resolved, entry] = await requireEntry(path);
        await backend.put(resolved, { ...entry, mode: mode & 0o7777 });
        return null;
      })());
    },

    fchmod(fd, mode, cb) {
      callback(cb, (async () => {
        const file = fds.get(fd);
        if (!file) throw fsError("EBADF");
        file.mode = mode & 0o7777;
        file.dirty = true;
        return null;
      })());
    },

    chown(path, uid, gid, cb) {
      callback(cb, Promise.resolve(null));
    },
    lchown(path, uid, gid, cb) {
      callback(cb, Promise.resolve(null));
    },
    fchown(fd, uid, gid, cb) {
      callback(cb, Promise.resolve(null));
    },

    utimes(path, atime, mtime, cb) {
      callback(cb, (async () => {
        const [resolved, entry] = await requireEntry(path);
        await backend.put(resolved, { ...entry, mtime: Number(mtime) * 1000 });
        return null;
      })());
    },

    fsync(fd, cb) {
      callback(cb, flushFd(fd).then(() => null));
    },

    readlink(path, cb) {
      callback(cb, (async () => {
        const [, entry] = await requireEntry(path, false);
        if (entry.kind !== "link") throw fsError("EINVAL", path);
        return entry.target;
      })());
    },

    symlink(target, path, cb) {
      callback(cb, (async () => {
        const resolved = await resolve(path, true, true);
        if (await entryAt(resolved)) throw fsError("EEXIST", path);
        const parent = await entryAt(dirname(resolved));
        if (!parent) throw fsError("ENOENT", path);
        await backend.put(resolved, {
          kind: "link",
          target,
          mode: 0o777,
          mtime: Date.now(),
        });
        return null;
      })());
    },

    link(existing, path, cb) {
      callback(cb, (async () => {
        const [, entry] = await requireEntry(existing);
        if (entry.kind === "dir") throw fsError("EPERM", existing);
        const resolved = await resolve(path, true, true);
        if (await entryAt(resolved)) throw fsError("EEXIST", path);
        await backend.put(resolved, entry);
        return null;
      })());
    },
  };

  const pathAPI = {
    resolve(...segments) {
      let value = "";
      for (const segment of segments) {
        if (!segment) continue;
        value = value ? value + "/" + segment : String(segment);
      }
      return normalize(value || cwd.value, cwd.value);
    },
    join(...segments) {
      return pathAPI.resolve(...segments);
    },
    dirname(path) {
      return dirname(normalize(path, "/"));
    },
    basename(path) {
      return basename(normalize(path, "/"));
    },
  };

  // The page's environment. Go reads its own copy through `go.env`, and the
  // modules bundled for the IDE read this one; both are filled from the same
  // object so a variable cannot mean two things depending on who asks.
  const processAPI = {
    env: { ...(options.env || {}) },
    argv: ["node"],
    platform: "linux",
    arch: "wasm",
    version: "v20.0.0",
    versions: { node: "20.0.0" },
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    on: () => processAPI,
    off: () => processAPI,
    once: () => processAPI,
    emit: () => false,
    removeListener: () => processAPI,
    hrtime: Object.assign((previous) => {
      const now = typeof performance === "undefined" ? Date.now() : performance.now();
      const seconds = Math.floor(now / 1000);
      const nanos = Math.floor((now % 1000) * 1e6);
      if (!previous) return [seconds, nanos];
      return [seconds - previous[0], nanos - previous[1] < 0 ? nanos - previous[1] + 1e9 : nanos - previous[1]];
    }, { bigint: () => BigInt(Math.floor((typeof performance === "undefined" ? Date.now() : performance.now()) * 1e6)) }),
    getuid: () => 1000,
    getgid: () => 1000,
    geteuid: () => 1000,
    getegid: () => 1000,
    getgroups: () => [1000],
    pid: 1,
    ppid: 0,
    umask: () => 0o022,
    cwd: () => cwd.value,
    chdir: (path) => {
      cwd.value = normalize(path, cwd.value);
    },
    exit: () => {},
  };

  // A POSIX tree has /tmp. Go's os.TempDir() resolves to it (or to $TMPDIR),
  // and the CLI unpacks every download into a subdirectory of it.
  const ready = (async () => {
    if (typeof backend.hydrate === "function") await backend.hydrate();
    if (!(await backend.get("/tmp"))) {
      await backend.put("/tmp", { kind: "dir", mode: 0o1777, mtime: Date.now() });
    }
  })();

  return {
    ready: () => ready,
    fs,
    path: pathAPI,
    process: processAPI,
    backend,
    async flushAll() {
      await Promise.all([...fds.keys()].map((fd) => flushFd(fd)));
    },
    async reset() {
      fds.clear();
      await backend.clear();
    },
    async usage() {
      const keys = await backend.keys();
      let bytes = 0;
      for (const key of keys) {
        const record = await backend.get(key);
        if (record && record.kind === "file") bytes += record.data.length;
      }
      return { entries: keys.length, bytes };
    },
  };
}

export { MemoryBackend, IdbBackend };
