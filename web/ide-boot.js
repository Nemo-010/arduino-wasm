// Boot for the IDE page.
//
// The IDE's own frontend is built by Theia and knows nothing about wasm. What it
// needs from this page is a `globalThis.arduinoCLI` before its services start,
// which is the same boot the console page uses (`web/bootstrap.js`). This script
// is a classic script because the generated index.html loads its bundle that
// way; the dynamic import is what reaches the module.
//
// It also seeds the CLI's settings file. The IDE's Board Manager is driven by
// `board_manager.additional_urls`, and a fresh profile has none, so the shipped
// nRF52 index would never be listed and "third-party board" would mean "type a
// URL". Writing the file once, only when absent, is what an IDE user would have
// done on first run -- and a later edit in the Board Manager rewrites this same
// file through the CLI, so the seed never fights the user.

(function () {
  const root = new URL('../', document.baseURI);
  const here = new URL('./', document.baseURI);
  // The service bundle and Theia's own bundle read process.env while their
  // modules are being defined. The nodefs shim that provides it is installed
  // by startPageCLI, whose imports are asynchronous over HTTP. Loading those
  // bundles as classic script tags raced that chain: on file:// the imports
  // won, on Pages they did not, and services.js died on
  // "Cannot read properties of undefined (reading 'NODE_DEBUG')" before it
  // could install a single service. They are loaded here, in order, only once
  // the shim is in place.
  const loadScript = (src) => new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(tag);
  });
  const logs = [];
  const log = text => {
    // The console page prints these; the IDE page has no log panel of its own,
    // and echoing backend lines into devtools is not an interface.
    if (logs.length < 400) {
      logs.push(String(text));
    }
  };
  globalThis.__cliLog = logs;

  const settingsPath = '/home/arduino/.arduino15/arduino-cli.yaml';

  globalThis.__arduinoCLIReady = (async () => {
    // The page's indexes are advertised under an origin that exists only in the
    // page, and this shim is what turns a fetch for them into a read of the file
    // beside the page -- for the CLI, whose HTTP client calls `fetch` too, not
    // only for our own assets. It has to be in place before the CLI starts.
    const { installIndexShim, AVR_INDEX_URL, NRF52_INDEX_URL } = await import(
      new URL('page-index.js', root).href
    );
    // The IDE page is one directory down, and the indexes are the site's.
    installIndexShim({ base: root.href });

    // The console page has the form for these; the IDE page has no settings UI,
    // so it reads the same keys. Leaving a key blank means the CLI's own URL --
    // for the library index that is Arduino's, which is the only index this
    // page does not carry and must therefore fetch like any other download.
    const { readConfig, settingsYaml } = await import(new URL('page-config.js', root).href);
    const config = readConfig();
    // The shipped nRF52 index is registered by default, so a third-party board
    // is one click away in the Board Manager rather than a URL to know. A user
    // who typed their own list on the console page gets that list instead.
    const settings = settingsYaml({ ...config, extraIndexes: config.extraIndexes || NRF52_INDEX_URL });

    const goEnv = {
      // Always set: the page carries the AVR index, so the CLI's own default
      // (downloads.arduino.cc) is not a URL this page serves.
      ARDUINO_DEFAULT_INDEX_URL: config.defaultIndex || AVR_INDEX_URL,
      // Same file the CLI opens, so an edit in the IDE's Board Manager lands
      // where the seed is.
      ARDUINO_CONFIG_FILE: settingsPath,
    };
    if (config.libraryIndex) {
      goEnv.ARDUINO_LIBRARIES_INDEX_URL = config.libraryIndex;
    }

    const { startPageCLI } = await import(new URL('bootstrap.js', root).href);
    const { cli } = await startPageCLI({
      log,
      goEnv,
      wasmUrl: new URL('arduino-cli.wasm', root).href,
      toolsBase: root.href,
      prepare: async ({ fs }) => {
        const dir = settingsPath.slice(0, settingsPath.lastIndexOf('/'));
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(settingsPath)) {
          fs.writeFileSync(settingsPath, settings);
        }
      },
    });
    globalThis.arduinoCLI = cli;
    await loadScript(new URL('services.js', here).href);
    await loadScript(new URL('bundle.js', here).href);
    return cli;
  })();

  // A failed boot must be readable by the page and by a test, not a silent
  // unhandled rejection with a spinner on top.
  globalThis.__arduinoCLIReady.catch(error => {
    globalThis.__arduinoCLIError = String((error && error.stack) || error);
  });
})();
