// Theia's filesystem RPC, answered from the filesystem the wasm CLI reads.
//
// The Electron app answers `/services/remote-filesystem` from a Node provider
// over the real disk, and arduino-cli reads that same disk. A page has one
// filesystem too: `globalThis.fs`, the shim in `web/nodefs.js` that the Go side
// of the wasm module is handed as `fs`. Two trees would let the editor save a
// sketch the compiler cannot see, so this provider is a thin adapter over that
// one instance and nothing else.
//
// The RPC surface is Theia's own `FileSystemProviderServer`, instantiated here
// rather than reimplemented: its method list, its capability checks and its
// error shapes are the ones the frontend was compiled against, and an upstream
// change arrives with the dependency instead of needing a patch here.

const { URI } = require("@theia/core/lib/common/uri");
const { FileUri } = require("@theia/core/lib/common/file-uri");
const { Emitter, Event } = require("@theia/core/lib/common/event");
const files = require("@theia/filesystem/lib/common/files");
const { FileSystemProviderServer } = require("@theia/filesystem/lib/common/remote-file-system-provider");
const { SharedFiles } = require("../shared-files");

// `access` and `open/read/write/close` are not offered: the shim serves whole
// files synchronously, so the frontend should use `readFile`/`writeFile`.
//
// `FileSystemProviderCapabilities` is a `declare const enum`, so TypeScript
// erased it and `files.js` carries only the inlined numbers (2, 8 and 1024 at
// `@theia/filesystem/lib/common/files.js:230-258`). They are written literally
// here and then checked with upstream's own predicates below, so a change to
// those values fails at construction instead of silently granting a capability
// the provider does not implement.
const FileReadWrite = 2;
const FileFolderCopy = 8;
const PathCaseSensitive = 1024;
const CAPABILITIES = FileReadWrite | FileFolderCopy | PathCaseSensitive;

function toPath(resource) {
  const uri = resource instanceof URI ? resource : new URI(resource);
  return FileUri.fsPath(uri);
}

// `FileSystemProvider.stat` answers a `Stat` and nothing else. The client
// rebuilds a `FileStat` from `type`, `ctime`, `mtime` and `size`, so extra
// fields are not a courtesy: they travel over the RPC encoder and a class
// instance among them is not part of the contract.
function fileStat(shared, path) {
  return shared.stat(path);
}

// The provider half of the RPC. Every method is async and every filesystem
// error already carries Theia's `FileSystemProviderErrorCode` string, which
// `SharedFiles` translates at the boundary.
function createProvider(fs) {
  const shared = new SharedFiles(fs);
  const changes = new Emitter();
  let disposed = false;

  return {
    capabilities: CAPABILITIES,
    onDidChangeCapabilities: Event.None,
    onFileWatchError: Event.None,
    onDidChangeFile: changes.event,

    // The provider contract is a `Stat` — `{ type, ctime, mtime, size }` — and
    // the client rebuilds a `FileStat` from those four fields alone.
    async stat(resource) {
      const uri = resource instanceof URI ? resource : new URI(resource);
      return fileStat(shared, toPath(uri));
    },

    // The provider contract is `[name, FileType][]`; `FileSystemProviderServer`
    // hands that array to the client unchanged and `FileService` destructures
    // each entry as a tuple.
    async readdir(resource) {
      const uri = resource instanceof URI ? resource : new URI(resource);
      return shared.readdir(toPath(uri));
    },

    async readFile(resource) {
      return shared.readFile(toPath(resource));
    },

    async writeFile(resource, content) {
      shared.writeFile(toPath(resource), content);
    },

    async mkdir(resource) {
      shared.mkdir(toPath(resource));
    },

    async delete(resource, options) {
      const path = toPath(resource);
      if (options && options.recursive === false) {
        // `rmSync` with `recursive` would empty a directory the caller meant to
        // remove only when empty; the shim's plain `rmdirSync` is that check.
        shared.rmdir(path);
        return;
      }
      shared.delete(path);
    },

    async rename(source, target) {
      shared.rename(toPath(source), toPath(target));
    },

    async copy(source, target) {
      shared.copy(toPath(source), toPath(target));
    },

    // No watcher: the shim has no change events to subscribe to, so this
    // registers nothing and emits nothing. A file the CLI writes during a
    // compile therefore does not refresh an open editor view on its own.
    watch() {
      return { dispose: () => undefined };
    },

    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      changes.dispose();
    },
  };
}

/**
 * The object `/services/remote-filesystem` is answered with.
 *
 * `FileSystemProviderServer` is Theia's own backend class; its `provider` field
 * is normally injected by inversify, and this bundle has no container to run
 * that, so it is assigned before `init()`.
 */
function createFileSystemService({ fs }) {
  const provider = createProvider(fs);
  // The numbers above are the contract; upstream's predicates are the check.
  if (
    !files.hasReadWriteCapability(provider) ||
    !files.hasFileFolderCopyCapability(provider) ||
    files.hasAccessCapability(provider) ||
    files.hasUpdateCapability(provider) ||
    files.hasFileReadStreamCapability(provider) ||
    files.hasOpenReadWriteCloseCapability(provider)
  ) {
    throw new Error("file-system: capability numbers no longer match @theia/filesystem");
  }
  const server = new FileSystemProviderServer();
  server.provider = provider;
  server.init();
  return server;
}

module.exports = { createFileSystemService, createProvider };
