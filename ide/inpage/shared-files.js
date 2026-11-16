'use strict';

// The IDE's file RPC, answered from the very filesystem the wasm CLI reads.
//
// In the Electron app the frontend's `RemoteFileSystemProvider` reaches a Node
// process whose `fs` is the same `fs` that arduino-cli's toolchain calls read
// through. A page has one filesystem too -- `web/nodefs.js`, an in-memory mirror
// written through to IndexedDB -- and both the Go side and this adapter use that
// single instance, exported as `globalThis.fs`. Two trees would mean the editor
// saves a sketch the compiler cannot see, which is the defect this class exists
// to make impossible.
//
// Every call is synchronous on purpose: the shim serves reads from a hydrated
// mirror, and the RPC layer awaits whatever a method returns.

const FileType = { File: 1, Directory: 2 };

// Theia's `FileOperationError` codes, which the frontend switches on. Node's
// errno `code` is not the same vocabulary: `ENOENT` reaches the UI as an
// unknown error, so the mapping happens here.
function fileError(message, code, cause) {
  const error = new Error(message + ' (FileSystemError)' + (cause ? ': ' + cause : ''));
  error.code = code;
  error.name = code;
  return error;
}

function translate(error, path) {
  const code = error && error.code;
  if (code === 'ENOENT') {
    return fileError('EntryNotFound', 'EntryNotFound', path);
  }
  if (code === 'ENOTDIR') {
    return fileError('EntryNotADirectory', 'EntryNotADirectory', path);
  }
  if (code === 'EISDIR') {
    return fileError('EntryIsDirectory', 'EntryIsDirectory', path);
  }
  if (code === 'EEXIST') {
    return fileError('AlreadyExists', 'AlreadyExists', path);
  }
  return error;
}

function asBytes(content) {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  return new Uint8Array(content);
}

class SharedFiles {
  constructor(fs) {
    this.fs = fs;
  }

  stat(path) {
    let stats;
    try {
      stats = this.fs.statSync(path);
    } catch (error) {
      throw translate(error, path);
    }
    return {
      type: stats.isDirectory() ? FileType.Directory : FileType.File,
      mtime: stats.mtimeMs || (stats.mtime && stats.mtime.getTime()) || Date.now(),
      ctime: stats.ctimeMs || (stats.ctime && stats.ctime.getTime()) || Date.now(),
      size: stats.size || 0,
    };
  }

  readdir(path) {
    let entries;
    try {
      entries = this.fs.readdirSync(path, { withFileTypes: true });
    } catch (error) {
      throw translate(error, path);
    }
    return entries.map(entry => [
      typeof entry === 'string' ? entry : entry.name,
      entry && entry.isDirectory && entry.isDirectory() ? FileType.Directory : FileType.File,
    ]);
  }

  readFile(path) {
    try {
      return asBytes(this.fs.readFileSync(path));
    } catch (error) {
      throw translate(error, path);
    }
  }

  writeFile(path, content) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    this.mkdirp(parent);
    try {
      this.fs.writeFileSync(path, content);
    } catch (error) {
      throw translate(error, path);
    }
  }

  mkdir(path) {
    try {
      this.fs.mkdirSync(path);
    } catch (error) {
      // An existing directory satisfies `mkdir` at the RPC layer; the frontend
      // calls it to make a folder the user already has.
      if (error && error.code === 'EEXIST') {
        return;
      }
      throw translate(error, path);
    }
  }

  mkdirp(path) {
    try {
      this.fs.mkdirSync(path, { recursive: true });
    } catch (error) {
      throw translate(error, path);
    }
  }

  delete(path) {
    try {
      this.fs.rmSync(path, { recursive: true, force: true });
    } catch (error) {
      throw translate(error, path);
    }
  }

  rmdir(path) {
    try {
      this.fs.rmdirSync(path);
    } catch (error) {
      throw translate(error, path);
    }
  }

  rename(from, to) {
    try {
      this.fs.renameSync(from, to);
    } catch (error) {
      throw translate(error, from);
    }
  }

  copy(from, to) {
    const info = this.stat(from);
    if (info.type === FileType.Directory) {
      this.mkdirp(to);
      for (const [name] of this.readdir(from)) {
        this.copy(from + '/' + name, to + '/' + name);
      }
      return;
    }
    const parent = to.slice(0, to.lastIndexOf('/')) || '/';
    this.mkdirp(parent);
    this.writeFile(to, this.readFile(from));
  }
}

module.exports = { SharedFiles, FileType };
