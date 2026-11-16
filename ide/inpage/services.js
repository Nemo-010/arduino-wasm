'use strict';

// The server half of the in-page backend: implementations for the RPC paths the
// frontend connects to. Everything here answers in the same shapes the Electron
// backend does, so no frontend code has to know it is running in a page.
//
// Not yet real: the filesystem is an in-memory tree and the sketch service
// fabricates sketches. Both are placeholders for the wasm CLI + IndexedDB
// storage, and are marked TODO below.

const { SharedFiles, FileType } = require('./shared-files');

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
  // The IDE's file RPC and the wasm CLI must read one tree. `globalThis.fs` is
  // the page's Node-shaped filesystem (web/nodefs.js), the same instance the Go
  // side calls, so an editor save is a file the compiler sees. Without it --
  // a Node test that has not built the shim -- `MemoryFiles` keeps the boot
  // working, and `window.__inpageFiles` says which one answered.
  const shared = typeof globalThis !== 'undefined' && globalThis.fs && typeof globalThis.fs.statSync === 'function';
  const files = shared ? new SharedFiles(globalThis.fs) : new MemoryFiles();
  if (typeof window !== 'undefined') {
    window.__inpageFiles = shared ? 'shared' : 'memory';
  }
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
    readFile: resource => files.readFile(fsPathOf(resource)),
    writeFile: (resource, content) => files.writeFile(fsPathOf(resource), content),
    mkdir: resource => files.mkdir(fsPathOf(resource)),
    delete: resource => files.delete(fsPathOf(resource)),
    rename: (source, target) => files.rename(fsPathOf(source), fsPathOf(target)),
    copy: (source, target) => files.copy(fsPathOf(source), fsPathOf(target)),
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
    files.mkdirp(folder);
    try {
      files.stat(main);
    } catch {
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

  // These have no backend behind them in a browser and never will: there is no
  // VS Code extension host to deploy plugins into, no debug adapter to launch,
  // no CLI preferences file, and no gRPC daemon port. Answering with the empty
  // shape is the true answer here, not a placeholder for missing work.
  define('/os', {
    getBackendOS: () => 'Linux',
  });

  define('/services/i18n', {
    getCurrentLanguage: () => 'en',
    setCurrentLanguage: () => undefined,
    getAvailableLanguages: () => [
      { languageId: 'en', languageName: 'English', languagePack: false },
    ],
    loadLocalization: languageId => ({ languageId, translations: {} }),
  });

  define('/services/cli-preferences', {
    getPreferences: () => [],
  });

  define('/services/plugin-paths', {
    getHostStoragePath: () => '/home/user/.theia/plugin-storage',
    getHostLogPath: () => '/tmp/plugin-host.log',
  });

  define('/services/debug', {
    debugTypes: () => [],
    getDebuggersForLanguage: () => [],
    getConfigurationSnippets: () => [],
    registerDebugAdapterFactory: () => undefined,
    unregisterDebugAdapterFactory: () => undefined,
  });

  define('/services/hostedPlugin', {
    getDeployedPluginIds: () => [],
    getUninstalledPluginIds: () => [],
    getDeployedPluginMetadata: () => [],
    getSupportedExtensions: () => [],
    getLatestUninstalledPluginVersion: () => undefined,
  });

  // Signing in needs the Arduino OAuth flow and a secret store; a page has
  // neither, so `session` reports nobody and `login` says why. Silently
  // pretending to sign in would be worse than refusing.
  define('/services/authentication-service', {
    session: () => undefined,
    setOptions: () => undefined,
    initAuthSession: () => undefined,
    logout: () => undefined,
    setClient: () => undefined,
    disposeClient: () => undefined,
    login: () => {
      throw new Error('sign-in is not available in the browser build');
    },
  });

  // There is no `arduino-cli daemon` process: the wasm CLI is called directly.
  define('/services/arduino-daemon', {
    tryGetPort: () => undefined,
  });

  // The services below are the ones the wasm CLI will fill in. Until that is
  // wired, they answer the empty value of the type they declare rather than
  // `undefined`: `undefined` reaches `.filter()`/`.map()` inside the frontend
  // and surfaces as a TypeError that hides the real gap.
  define('/services/boards-service', {
    search: () => [],
    searchBoards: () => [],
    getInstalledBoards: () => [],
    getInstalledPlatforms: () => [],
    getDetectedPorts: () => ({}),
    getBoardPackage: () => undefined,
    getContainerBoardPackage: () => undefined,
    getBoardDetails: () => undefined,
    checkDebugEnabled: () => '',
    install: () => undefined,
    uninstall: () => undefined,
    updateIndex: () => undefined,
  });

  define('/services/config-service', {
    // The declared union has this member: no config yet, and no messages.
    getConfiguration: () => ({ config: undefined, messages: [] }),
    setConfiguration: () => undefined,
  });

  define('/services/example-service', {
    builtIns: () => [],
    installed: () => ({ user: [], current: [], any: [] }),
    find: () => [],
  });

  define('/services/library-service', {
    search: () => [],
    list: () => [],
    install: () => undefined,
    installZip: () => undefined,
    uninstall: () => undefined,
    updateIndex: () => undefined,
    listDependencies: () => [],
  });

  // A summary is a map of index type to completion time; empty means none.
  define('/services/core-service', {
    indexUpdateSummaryBeforeInit: () => ({}),
    updateIndex: () => undefined,
    refresh: () => undefined,
    compile: () => {
      throw new Error(
        'compiling is not wired up yet: the toolchain needs to run, which this page cannot do',
      );
    },
    upload: () => {
      throw new Error('uploading is not wired up yet');
    },
    burnBootloader: () => {
      throw new Error('burning a bootloader is not wired up yet');
    },
  });

  define('/services/arduino-firmware-uploader', {
    updatableBoards: () => [],
    list: () => [],
    availableFirmwares: () => [],
    uploadCertificates: () => undefined,
    flash: () => {
      throw new Error('flashing firmware is not wired up yet');
    },
  });

  return {
    calls,
    get: path => entries.get(path),
  };
}

module.exports = { createServices };
