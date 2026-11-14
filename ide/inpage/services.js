'use strict';

// The server half of the in-page backend: implementations for the RPC paths the
// frontend connects to. Everything here answers in the same shapes the Electron
// backend does, so no frontend code has to know it is running in a page.
//
// Not yet real: the filesystem is an in-memory tree and the sketch service
// fabricates sketches. Both are placeholders for the wasm CLI + IndexedDB
// storage, and are marked TODO below.

const FileType = { File: 1, Directory: 2 };

// FileReadWrite | FileFolderCopy | PathCaseSensitive
const CAPABILITIES = 2 | 8 | 1024;

const LEVEL_NAMES = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function fsPathOf(uri) {
  const raw = uri.indexOf('://') === -1 ? uri : uri.slice(uri.indexOf('://') + 3);
  return raw.startsWith('/') ? raw : '/' + raw;
}

function notFound(uri) {
  const error = new Error('EntryNotFound (FileSystemError): ' + uri);
  error.code = 'EntryNotFound';
  error.name = 'EntryNotFound';
  return error;
}

/**
 * An in-memory tree, addressed by `file://` URIs. Enough to render a workspace;
 * replaced by web/nodefs.js over IndexedDB so the wasm CLI sees the same files.
 */
class MemoryFiles {
  constructor() {
    const now = Date.now();
    this.nodes = new Map([['/', { type: FileType.Directory, mtime: now, ctime: now }]]);
    this.sketches = new Map();
  }

  stat(path) {
    const node = this.nodes.get(path);
    if (!node) {
      throw notFound(path);
    }
    return {
      type: node.type,
      mtime: node.mtime,
      ctime: node.ctime,
      size: node.content ? node.content.length : 0,
    };
  }

  mkdir(path) {
    if (this.nodes.has(path)) {
      return;
    }
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (!this.nodes.has(parent)) {
      const error = new Error('EntryNotFound (FileSystemError): ' + parent);
      error.code = 'EntryNotFound';
      throw error;
    }
    const now = Date.now();
    this.nodes.set(path, { type: FileType.Directory, mtime: now, ctime: now });
  }

  mkdirp(path) {
    let partial = '';
    for (const part of path.split('/').filter(Boolean)) {
      partial += '/' + part;
      this.mkdir(partial);
    }
  }

  writeFile(path, content) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    this.mkdirp(parent);
    const now = Date.now();
    const previous = this.nodes.get(path);
    this.nodes.set(path, {
      type: FileType.File,
      mtime: now,
      ctime: previous ? previous.ctime : now,
      content,
    });
  }

  readdir(path) {
    const node = this.nodes.get(path);
    if (!node) {
      throw notFound(path);
    }
    if (node.type !== FileType.Directory) {
      const error = new Error('EntryNotADirectory (FileSystemError): ' + path);
      error.code = 'EntryNotADirectory';
      throw error;
    }
    const prefix = path === '/' ? '/' : path + '/';
    const children = [];
    for (const [key, value] of this.nodes) {
      if (key === path || !key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
      if (rest.indexOf('/') === -1) {
        children.push([rest, value.type]);
      }
    }
    return children;
  }

  delete(path) {
    if (!this.nodes.has(path)) {
      throw notFound(path);
    }
    const prefix = path === '/' ? '/' : path + '/';
    for (const key of [...this.nodes.keys()]) {
      if (key === path || key.startsWith(prefix)) {
        this.nodes.delete(key);
      }
    }
  }
}

function createServices({ log }) {
  const files = new MemoryFiles();
  const entries = new Map();
  const calls = [];
  let sketchCounter = 0;
  let watchCounter = 0;

  const record = (path, method, argc) => {
    calls.push({ path, method, argc });
  };

  const define = (path, target) => entries.set(path, target);

  const defaultInoContent = () => 'void setup() {\n}\n\nvoid loop() {\n}\n';

  define('/services/logger', {
    setLogLevel: () => undefined,
    getLogLevel: () => 30,
    log: (name, level, message, params) => {
      log(LEVEL_NAMES[level] || String(level), name, message, params);
      return undefined;
    },
    child: () => undefined,
    setClient: () => undefined,
    dispose: () => undefined,
  });

  define('/services/keyboard', {
    getNativeLayout: () => ({
      info: { id: 'pc105', name: 'US Keyboard', locale: 'en', model: 'pc105' },
      mapping: {},
    }),
  });

  define('/services/application', {
    getApplicationInfo: () => ({ name: 'Arduino IDE', version: '2.3.11' }),
    getApplicationRoot: () => '',
    getApplicationPlatform: () => 'browser',
    getExtensionsInfos: () => [],
    getBackendOS: () => 'Linux',
  });

  define('/services/envs', {
    getExecPath: () => '/',
    getVariables: () => [],
    getValue: key => ({ name: key, value: undefined }),
    getConfigDirUri: () => 'file:///config',
    getHomeDirUri: () => 'file:///home/user',
    getDrives: () => ['file:///'],
  });

  define('/services/workspace', {
    getMostRecentlyUsedWorkspace: () => undefined,
    setMostRecentlyUsedWorkspace: () => undefined,
    removeRecentWorkspace: () => undefined,
    getRecentWorkspaces: () => [],
    setClient: () => undefined,
  });

  define('/services/stopwatch', {
    start: () => 1,
    stop: () => undefined,
  });

  define('/services/task', {
    getTasks: () => [],
    setClient: () => undefined,
  });

  define('/services/remote-filesystem', {
    getCapabilities: () => CAPABILITIES,
    getReadOnlyMessage: () => undefined,
    stat: resource => files.stat(fsPathOf(resource)),
    access: resource => files.stat(fsPathOf(resource)),
    fsPath: resource => fsPathOf(resource),
    readdir: resource => files.readdir(fsPathOf(resource)),
    readFile: resource => {
      const node = files.nodes.get(fsPathOf(resource));
      if (!node) {
        throw notFound(resource);
      }
      return node.content || new Uint8Array(0);
    },
    writeFile: (resource, content) => files.writeFile(fsPathOf(resource), content),
    mkdir: resource => files.mkdir(fsPathOf(resource)),
    delete: resource => files.delete(fsPathOf(resource)),
    rename: (source, target) => {
      const from = fsPathOf(source);
      const to = fsPathOf(target);
      const node = files.nodes.get(from);
      if (!node) {
        throw notFound(source);
      }
      const moved = [...files.nodes.entries()].filter(([key]) => key === from || key.startsWith(from + '/'));
      for (const [key, value] of moved) {
        files.nodes.delete(key);
        files.nodes.set(to + key.slice(from.length), value);
      }
    },
    copy: (source, target) => {
      const from = fsPathOf(source);
      const to = fsPathOf(target);
      const copied = [...files.nodes.entries()].filter(([key]) => key === from || key.startsWith(from + '/'));
      for (const [key, value] of copied) {
        files.nodes.set(to + key.slice(from.length), { ...value });
      }
    },
    watch: () => {
      watchCounter += 1;
      return undefined;
    },
    unwatch: () => undefined,
    setClient: () => undefined,
  });

  const sketchFolder = sketch => {
    const folder = fsPathOf(sketch.uri);
    const main = fsPathOf(sketch.mainFileUri);
    if (files.nodes.has(folder) && files.nodes.get(folder).type === FileType.Directory) {
      return sketch;
    }
    files.mkdirp(folder);
    if (!files.nodes.has(main)) {
      files.writeFile(main, new TextEncoder().encode(defaultInoContent()));
    }
    return sketch;
  };

  const newSketch = () => {
    sketchCounter += 1;
    const now = new Date();
    const stamp =
      now.toISOString().slice(0, 10).replace(/-/g, '') + String.fromCharCode(96 + ((now.getMonth() + sketchCounter) % 26) + 1);
    const name = 'sketch_' + stamp;
    const uri = 'file:///home/user/Arduino/' + name;
    const sketch = {
      name,
      uri,
      mainFileUri: uri + '/' + name + '.ino',
      otherSketchFileUris: [],
      additionalFileUris: [],
      rootFolderFileUris: [],
    };
    return sketchFolder(sketch);
  };

  define('/services/sketches-service', {
    createNewSketch: () => newSketch(),
    defaultInoContent: () => defaultInoContent(),
    getSketches: () => ({ label: '', children: [], sketches: [] }),
    loadSketch: uri => sketchFolder({ name: uri.split('/').pop(), uri, mainFileUri: uri + '/' + uri.split('/').pop() + '.ino', otherSketchFileUris: [], additionalFileUris: [], rootFolderFileUris: [] }),
    maybeLoadSketch: () => undefined,
    isSketchFolder: () => false,
    isTemp: () => true,
    getSketchFolder: () => undefined,
    markAsRecentlyOpened: () => undefined,
    recentlyOpenedSketches: () => [],
    cloneExample: uri => sketchFolder({ name: uri.split('/').pop(), uri, mainFileUri: uri + '/' + uri.split('/').pop() + '.ino', otherSketchFileUris: [], additionalFileUris: [], rootFolderFileUris: [] }),
    copy: sketch => sketch,
    archive: () => '',
    getIdeTempFolderUri: () => 'file:///tmp/arduino-ide',
    checkSketchCasing: () => 'ok',
  });

  return {
    calls,
    get: path => entries.get(path),
  };
}

module.exports = { createServices };
