// Puts arduino-ide's own backend services in the page.
//
// Nothing here re-implements a service. The classes below are the ones the
// Electron app's backend module binds, compiled from the extension's own
// TypeScript, and they talk to arduino-cli exactly as they do on the desktop:
// `CoreClientProvider.create()` makes the instance, initializes it, and runs the
// IDE's own index-recovery path when the package index is missing. What changes
// is only what lies under that provider -- the wasm CLI instead of a spawned
// daemon -- plus the handful of page-level answers a browser has to give for
// filesystem, environment and process questions.
//
// The caller supplies the three things that belong to the page's own UI: where
// log lines go, how a notification reaches the user, and where compile output
// is appended.

// The extension's classes are decorated with inversify's TypeScript decorators,
// which call `Reflect.hasOwnMetadata` while the module is being defined. The
// Electron app loads this polyfill before the backend; a bundle has to do the
// same thing, and it has to be the very first import.
require("reflect-metadata");


const { Disposable } = require("@theia/core/lib/common/disposable");
const { CoreClientProvider } = require("arduino-extension/node/core-client-provider");
const { BoardDiscovery } = require("arduino-extension/node/board-discovery");
const { BoardsServiceImpl } = require("arduino-extension/node/boards-service-impl");
const { LibraryServiceImpl } = require("arduino-extension/node/library-service-impl");
const { CoreServiceImpl } = require("arduino-extension/node/core-service-impl");
const { SketchesServiceImpl } = require("arduino-extension/node/sketches-service-impl");
const { ConfigServiceImpl } = require("arduino-extension/node/config-service-impl");
const { SettingsReader } = require("arduino-extension/node/settings-reader");
const { IsTempSketch } = require("arduino-extension/node/is-temp-sketch");
const { ArduinoDaemonImpl } = require("./daemon");
const { EnvVariablesServer, CONFIG } = require("./env-vars");
const { createFileSystemService } = require("./file-system");

function consoleLogger(logger) {
  const write = (level) => (message, ...rest) => {
    logger(level, [message, ...rest].join(" "));
  };
  const log = { info: write("info"), warn: write("warn"), error: write("error"), debug: write("debug"), trace: write("trace"), log: write("info") };
  log.child = () => log;
  return log;
}

// A notification names an event the page has to show. Recording it beats
// pretending it was delivered: `createIdeServices` hands the list back so the
// page's own notification area can render it.
function notificationServer(notifications, notify) {
  // A Proxy spread into an object literal copies own keys and nothing else, so
  // `{ ...proxy, notify }` would answer every notification method with
  // `undefined` and `CoreClientProvider.init` would die on
  // `notifyIndexUpdateWillStart is not a function`. The Proxy is the target of a
  // second Proxy instead, which keeps the fallback and adds the one real method.
  const recording = new Proxy(
    {},
    {
      get(_target, name) {
        return (...args) => {
          notifications.push({ name: String(name), args });
        };
      },
    },
  );
  if (!notify) {
    return recording;
  }
  return new Proxy(
    { notify },
    {
      get(target, name) {
        return name in target ? target[name] : recording[name];
      },
    },
  );
}

async function createIdeServices({ log, notify, appendToOutput }) {
  const logger = consoleLogger(log);
  const notifications = [];
  const notifyServer = notificationServer(notifications, notify);
  const responseService = { appendToOutput: (message, options) => appendToOutput(message, options) };
  const envVariablesServer = new EnvVariablesServer();
  const daemon = new ArduinoDaemonImpl(logger);

  const configService = new ConfigServiceImpl();
  configService.logger = logger;
  configService.envVariablesServer = envVariablesServer;
  configService.daemon = daemon;
  configService.notificationService = notifyServer;

  const clientProvider = new CoreClientProvider();
  clientProvider.logger = logger;
  clientProvider.daemon = daemon;
  clientProvider.configService = configService;
  clientProvider.notificationService = notifyServer;
  clientProvider.version = "arduino-wasm";

  const boardDiscovery = new BoardDiscovery();
  boardDiscovery.logger = logger;
  boardDiscovery.coreClientProvider = clientProvider;

  const boardsService = new BoardsServiceImpl();
  boardsService.logger = logger;
  boardsService.responseService = responseService;
  boardsService.notificationService = notifyServer;
  boardsService.boardDiscovery = boardDiscovery;
  boardsService.coreClientProvider = clientProvider;

  const libraryService = new LibraryServiceImpl();
  libraryService.logger = logger;
  libraryService.responseService = responseService;
  libraryService.boardDiscovery = boardDiscovery;
  libraryService.notificationServer = notifyServer;
  libraryService.coreClientProvider = clientProvider;

  const settingsReader = new SettingsReader();
  settingsReader.envVariableServer = envVariablesServer;

  const isTempSketch = new IsTempSketch();

  const sketchesService = new SketchesServiceImpl();
  sketchesService.logger = logger;
  sketchesService.configService = configService;
  sketchesService.notificationService = notifyServer;
  sketchesService.envVariableServer = envVariablesServer;
  sketchesService.isTempSketch = isTempSketch;
  sketchesService.settingsReader = settingsReader;
  // `SketchesServiceImpl` extends `CoreClientAware`, whose `coreClient` getter
  // reads this field; without it every sketch load dies on `undefined.client`.
  sketchesService.coreClientProvider = clientProvider;

  // The serial monitor needs a serial port, and the page has WebSerial, not
  // `serialport`. Naming that here keeps a missing monitor honest instead of
  // leaving a service that silently answers nothing.
  const monitorManager = new Proxy(
    {},
    {
      get(_target, name) {
        return () => {
          throw new Error("The serial monitor is not wired to WebSerial yet (monitorManager." + String(name) + ")");
        };
      },
    },
  );

  // The frontend's whole filesystem is this RPC: without it no editor opens, no
  // sketch tree is listed, and Theia's own keymap store cannot load.
  const fileSystemService = createFileSystemService({ fs: globalThis.fs });

  const coreService = new CoreServiceImpl();
  coreService.responseService = responseService;
  coreService.monitorManager = monitorManager;
  coreService.boardDiscovery = boardDiscovery;
  coreService.notificationService = notifyServer;
  coreService.coreClientProvider = clientProvider;

  // `ConfigServiceImpl` starts through the Theia lifecycle hook, not an `init()`.
  // The page has no inversify container to run that lifecycle, so it calls the
  // hook itself -- the same method the Electron app's container would call.
  configService.onStart();
  // `CoreClientProvider.init()` waits for the daemon's started event, which is
  // what `daemon.start()` below raises; that path is the Electron app's own.
  clientProvider.init();
  await daemon.start();

  return {
    container: {
      configService,
      clientProvider,
      boardDiscovery,
      boardsService,
      libraryService,
      sketchesService,
      coreService,
      fileSystemService,
      settingsReader,
      envVariablesServer,
      daemon,
      notifications,
      dispose: () => {
        daemon.stop();
        clientProvider["closeClient"] && clientProvider["closeClient"]();
      },
      Disposable,
      CONFIG,
    },
  };
}

module.exports = { createIdeServices };
