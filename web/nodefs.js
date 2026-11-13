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

const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 0x40;
const O_EXCL = 0x80;
const O_TRUNC = 0x200;
const O_APPEND = 0x400;
const O_DIRECTORY = 0x10000;

export function fsError(code, path) {
  const error = new Error(code + (path ? ": " + path : ""));
  error.code = code;
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
  const backend = options.backend || new MemoryBackend();
  const stdout = options.stdout || ((text) => console.log(text));
  const stderr = options.stderr || ((text) => console.error(text));
  const cwd = { value: options.cwd || "/" };

  const fds = new Map();
  let nextFd = 3;
  const decoder = new TextDecoder();

  async function entryAt(path) {
    if (path === "/") {
      return { kind: "dir", mode: 0o755, mtime: 0 };
    }
    return backend.get(path);
  }

  // Resolve a path, expanding symlinks. followLast=false gives lstat semantics.
  async function resolve(path, followLast = true, allowMissing = false, depth = 0) {
    if (depth > 32) throw fsError("ELOOP", path);
    let current = "/";
    const parts = normalize(path, cwd.value).split("/").filter(Boolean);
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

    mkdir(path, mode, cb) {
      callback(cb, (async () => {
        const resolved = await resolve(path, true, true);
        if (await entryAt(resolved)) throw fsError("EEXIST", path);
        const parent = await entryAt(dirname(resolved));
        if (!parent) throw fsError("ENOENT", path);
        if (parent.kind !== "dir") throw fsError("ENOTDIR", path);
        await backend.put(resolved, { kind: "dir", mode: MODE_DIR(mode), mtime: Date.now() });
        return null;
      })());
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

    readdir(path, cb) {
      callback(cb, (async () => {
        const [resolved, entry] = await requireEntry(path);
        if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
        return backend.children(resolved);
      })());
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

    read(fd, buffer, offset, length, position, cb) {
      callback(cb, (async () => {
        if (fd === 0) return 0;
        const file = fds.get(fd);
        if (!file) throw fsError("EBADF");
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
        if (file.kind !== "file") throw fsError("EISDIR");
        const append = (file.flags & O_APPEND) !== 0;
        const start = append
          ? file.data.length
          : position === null || position === undefined
            ? file.offset
            : Number(position);
        const end = start + length;
        if (end > file.data.length) {
          const data = new Uint8Array(end);
          data.set(file.data);
          file.data = data;
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

  const processAPI = {
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
