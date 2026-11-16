'use strict';

// An in-page stand-in for the Theia backend.
//
// Theia's frontend talks to a backend over a multiplexed binary channel: the
// transport carries Open/AckOpen/Data/Close frames, and each opened channel
// carries JSON-RPC. Nothing in that requires a socket, so this module wires the
// frontend's client end to a server end living in the same page, using Theia's
// own ChannelMultiplexer and RpcProxyFactory on both sides. No transport code is
// reimplemented; only the pipe between the two multiplexers is.

const { ChannelMultiplexer } = require('@theia/core/lib/common/message-rpc/channel');
const { RpcProxyFactory } = require('@theia/core/lib/common/messaging/proxy-factory');
const { ConnectionSource } = require('@theia/core/lib/browser/messaging/connection-source');
const {
  ServiceConnectionProvider,
  LocalConnectionProvider,
  RemoteConnectionProvider,
} = require('@theia/core/lib/browser/messaging/service-connection-provider');
const {
  ElectronWebSocketConnectionSource,
} = require('@theia/core/lib/electron-browser/messaging/electron-ws-connection-source');
const { LoopbackChannel, InPageConnectionSource } = require('./channel');
const { createServices } = require('./services');

/** Every RPC call the frontend makes, so a test can read them back. */
const calls = [];
/** Methods with no implementation yet: what the frontend still needs. */
const missing = [];

// A boot that loops over the same call must not fill memory. Keep the first
// entries, count the rest, so the loop is visible instead of fatal.
const MAX_RECORDED = 4000;
const counters = { calls: 0, missing: 0, logs: 0 };

function record(list, entry) {
  counters[list === calls ? 'calls' : 'missing'] += 1;
  if (list.length < MAX_RECORDED) {
    list.push(entry);
  }
}

function summarize(arg) {
  if (typeof arg === 'string') {
    return arg.length > 120 ? arg.slice(0, 120) + '…(' + arg.length + ')' : arg;
  }
  if (arg instanceof Uint8Array) {
    return 'Uint8Array(' + arg.length + ')';
  }
  if (Array.isArray(arg)) {
    return 'Array(' + arg.length + ')';
  }
  if (arg && typeof arg === 'object') {
    return '{' + Object.keys(arg).slice(0, 12).join(',') + '}';
  }
  return typeof arg;
}

function logToConsole(level, name, message, params) {
  if (level === 'trace' || level === 'debug') {
    return;
  }
  // Never echo through `console`: Theia's frontend logger forwards console
  // output back to this server, so printing here feeds itself.
  if (counters.logs > 300 || typeof window === 'undefined') {
    return;
  }
  counters.logs += 1;
  let text;
  try {
    text = typeof message === 'string' ? message : JSON.stringify(message);
  } catch {
    text = String(message);
  }
  window.__backendLog = window.__backendLog || [];
  window.__backendLog.push({ level, name, text, params: Array.isArray(params) ? params : [] });
}

// Paths answered by arduino-ide's own service implementations, which arrive in
// `ArduinoIdeServices` -- the bundle of the extension's backend classes talking
// to the wasm CLI. Everything else keeps the stub: where a browser has no such
// backend at all (no plugin host, no debug adapter), the stub's empty answer is
// the true one rather than a placeholder.
//
// `sketches-service` is deliberately absent for now: `SketchesServiceImpl` needs
// a workspace service and reads the sketchbook through Theia's filesystem, and
// the page's file RPC already places sketches on the one tree the CLI reads.
const REAL_PATHS = new Set([
  '/services/boards-service',
  '/services/library-service',
  '/services/core-service',
  '/services/config-service',
  '/services/arduino-daemon',
  '/services/remote-filesystem',
  '/services/sketches-service',
]);

const realServices = {
  // Resolves to a Map of path -> implementation, empty when the bundle is not on
  // the page. Never rejects: a missing bundle must leave the stubs answering.
  promise: Promise.resolve(new Map()),
  error: undefined,
  map: new Map(),
};

/** The page's hooks for the real services: where their output and notifications go. */
function pageHooks() {
  const output = [];
  const notifications = [];
  if (typeof window !== 'undefined') {
    window.__inpageOutput = output;
    window.__inpageNotifications = notifications;
  }
  return {
    output,
    notifications,
    log: (level, message) => logToConsole(level, 'ide-services', message, []),
    notify: (name, ...args) => {
      notifications.push({ name, args });
    },
    appendToOutput: message => {
      // ResponseService.appendToOutput sends `{ chunk }`, not a string, so a
      // sink that only accepted strings recorded `[object Object]` once per
      // compiler line.
      if (typeof message === 'string') output.push(message);
      else if (message && typeof message.chunk === 'string') output.push(message.chunk);
      else output.push(String(message));
    },
  };
}

function bootRealServices(services) {
  const bundle = typeof globalThis !== 'undefined' ? globalThis.ArduinoIdeServices : undefined;
  if (!bundle || typeof bundle.createIdeServices !== 'function') {
    // The page was built without the bundle: the stubs answer, and this says so
    // once instead of looking like a backend that lost half its methods.
    if (typeof window !== 'undefined') {
      window.__inpageReal = 'missing';
    }
    return realServices.promise;
  }

  const hooks = pageHooks();
  // The CLI has to be running before a service asks it anything. The page's own
  // boot script (web/ide-boot.js) publishes that promise; when it is absent --
  // the Node test drives the bundle directly -- this resolves at once.
  const cliReady = globalThis.__arduinoCLIReady;
  const started = cliReady && typeof cliReady.then === 'function' ? cliReady : Promise.resolve();
  realServices.promise = started
    .then(() => bundle.createIdeServices(hooks))
    .then(({ container }) => {
      realServices.map = new Map([
        ['/services/boards-service', container.boardsService],
        ['/services/library-service', container.libraryService],
        ['/services/core-service', container.coreService],
        ['/services/config-service', container.configService],
        ['/services/arduino-daemon', container.daemon],
        ['/services/remote-filesystem', container.fileSystemService],
        ['/services/sketches-service', container.sketchesService],
      ]);
      if (typeof window !== 'undefined') {
        window.__inpageReal = 'bundled';
        window.__inpageRealServices = Object.fromEntries(realServices.map.keys().map(key => [key, true]));
      }
      return realServices.map;
    })
    .catch(error => {
      realServices.error = String((error && error.stack) || error);
      // A real service that fails to boot must not take the page with it: the
      // stubs still answer, and the failure is readable by name.
      if (typeof window !== 'undefined') {
        window.__inpageReal = 'failed';
        window.__inpageRealError = realServices.error;
      }
      return realServices.map;
    });
  return realServices.promise;
}

/** The object the RPC layer calls into for one service path. */
function createTargets(services) {
  return path => {
    const impl = services.get(path) || Object.create(null);
    if (typeof window !== 'undefined') {
      window.__inpageServices[path] = impl;
    }
    const target = new Proxy(Object.create(null), {
      get(_target, name) {
        if (typeof name !== 'string' || name === 'then' || name === 'toJSON') {
          return undefined;
        }
        return (...args) => {
          record(calls, { path, method: name, argc: args.length });
          const stub = impl[name];
          const callStub = () => {
            if (typeof stub !== 'function') {
              record(missing, { path, method: name, argc: args.length, args: args.map(summarize) });
              return undefined;
            }
            return stub(...args);
          };
          if (!REAL_PATHS.has(path)) {
            return callStub();
          }
          // The real implementation wins where it has the method; the stub fills
          // the rest, and the fall-through is recorded so it stays visible.
          return realServices.promise.then(map => {
            const real = map.get(path);
            if (real && typeof real[name] === 'function') {
              record(calls, { path, method: name, via: 'real' });
              return real[name](...args);
            }
            return callStub();
          });
        };
      },
    });
    // The page test drives the same object the frontend's RPC does, so a call
    // that reached a real service is recorded with via:'real' either way.
    if (typeof window !== 'undefined') {
      window.__inpageTargets[path] = target;
    }
    return target;
  };
}

function attachServer(serverChannel, targetFor) {
  const multiplexer = new ChannelMultiplexer(serverChannel);
  multiplexer.onDidOpenChannel(({ id, channel }) => {
    const factory = new RpcProxyFactory();
    factory.target = targetFor(id);
    factory.listen(channel);
  });
}

/**
 * Replace the messaging bindings so nothing tries to reach a backend, and stub
 * the Electron preload API, which a browser does not have.
 */
function install(container) {
  stubElectron();

  if (typeof window !== 'undefined') {
    window.__inpageCalls = calls;
    window.__inpageMissing = missing;
    window.__inpageCounters = counters;
    window.__inpageServices = Object.create(null);
    window.__inpageTargets = Object.create(null);
    window.__inpageInstalled = true;
  }

  const source = new InPageConnectionSource();
  const provider = new ServiceConnectionProvider();
  provider.connectionSource = source;
  provider.init();

  // Not every symbol is bound in the root container: `ConnectionSource` and the
  // socket sources arrive through other modules, and a `rebind` of something
  // absent throws before the rest of the override runs.
  const override = (id, value) => {
    if (container.isBound(id)) {
      container.rebind(id).toConstantValue(value);
    } else {
      container.bind(id).toConstantValue(value);
    }
  };

  override(ConnectionSource, source);
  override(ServiceConnectionProvider, provider);
  override(LocalConnectionProvider, provider);
  override(RemoteConnectionProvider, provider);

  // The electron source is a FrontendApplicationContribution and would open a
  // socket.io connection to /services, then retry forever against a page that
  // has no server. Neutralise the connection attempt, keep the binding shape.
  if (container.isBound(ElectronWebSocketConnectionSource)) {
    container.rebind(ElectronWebSocketConnectionSource).to(OfflineSocketSource).inSingletonScope();
  } else {
    container.bind(ElectronWebSocketConnectionSource).to(OfflineSocketSource).inSingletonScope();
  }

  const services = createServices({ log: logToConsole });
  // Booting the real services is asynchronous -- it starts the wasm CLI -- and
  // `install()` is called while the container loads, so the promise is kept and
  // consulted per call instead of awaited here.
  bootRealServices(services);
  source.open(server => attachServer(server, createTargets(services)));
}

class OfflineSocketSource extends ElectronWebSocketConnectionSource {
  openSocket() {
    // The RPC traffic goes over the in-memory channel pair, so no websocket is
    // opened. The connection-status service still asks the socket whether the
    // backend is up (`socket.connected`), and in this build it always is:
    // the backend runs in this same page.
    this._socket = {
      connected: true,
      close: () => undefined,
    };
  }
}

/**
 * The Electron preload scripts provide `window.electronTheiaCore` and
 * `window.electronArduino`. Menu, window, keyboard-layout, theme and app-service
 * code calls them at start, so each name has to answer something. A Proxy that
 * returns a resolving function covers the calls whose value is only reported
 * back; the few whose value is read get an answer with the right shape.
 */
function stubElectron() {
  if (typeof window === 'undefined') {
    return;
  }
  const resolving = overrides => {
    const cache = new Map();
    return new Proxy(Object.create(null), {
      get(_target, name) {
        if (typeof name !== 'string') {
          return undefined;
        }
        if (Object.prototype.hasOwnProperty.call(overrides, name)) {
          return overrides[name];
        }
        if (!cache.has(name)) {
          cache.set(name, () => Promise.resolve(undefined));
        }
        return cache.get(name);
      },
    });
  };

  if (!window.electronTheiaCore) {
    window.electronTheiaCore = resolving({});
  }
  if (!window.electronArduino) {
    window.electronArduino = resolving({
      appInfo: () => Promise.resolve({ name: 'Arduino IDE', version: '2.3.11', commit: '', buildDate: '' }),
      isFirstWindow: () => Promise.resolve(true),
      setMenu: () => undefined,
      registerStartupTasksHandler: () => ({ dispose: () => undefined }),
      registerPlotterWindowCloseHandler: () => ({ dispose: () => undefined }),
      openPath: () => undefined,
      quitApp: () => undefined,
    });
  }
  if (!window.electron) {
    window.electron = { ipcRenderer: { invoke: () => Promise.resolve(undefined), send: () => undefined, on: () => undefined } };
  }
}

module.exports = { install, stub: stubElectron };

// The Electron preload scripts run before `install()` gets the container, and a
// missing `window.electronTheiaCore` leaves them hanging rather than throwing.
// Stub as soon as this module is loaded.
stubElectron();
