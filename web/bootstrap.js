// Starting the wasm CLI, once, for both pages.
//
// The console page (web/app.js) and the IDE page (web/ide-boot.js) need the same
// four steps before any call is possible: a filesystem the Go runtime accepts,
// the toolchains behind the exec seam, a `Go` instance with the environment, and
// the wasm module itself. Two copies of that would drift, and the second one
// would drift first on the day `installPageTools` changes shape.
//
// The page loads `wasm_exec.js` as a classic script; it installs `globalThis.Go`
// and leaves an existing `fs`/`path`/`process` alone.

import { createNodeFS, IdbBackend, MemoryBackend } from "./nodefs.js";
import { installPageTools } from "./page-tools.js";

// The build output is not committed; say how to make it instead of failing with
// a JSON or wasm parse error.
export const MISSING_BUILD = "build it first: python3 scripts/update.py";

// `file://` has no fetch, and the IDE page is loaded from disk in the test that
// grades it. XHR reads the same bytes there, and `instantiateStreaming` is only
// skipped, not the module: the bytes are identical.
async function readWasm(url) {
  if (typeof fetch === 'function') {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${url} is not readable (${response.status}): ${MISSING_BUILD}`);
      }
      return response.arrayBuffer();
    } catch (error) {
      if (!/^file:/.test(url) && !/^file:/.test(globalThis.location ? globalThis.location.href : '')) {
        throw error;
      }
    }
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.onload = () => {
      if (request.status === 200 || request.status === 0) {
        resolve(request.response);
      } else {
        reject(new Error(`${url} is not readable (${request.status}): ${MISSING_BUILD}`));
      }
    };
    request.onerror = () => reject(new Error(`${url} is not readable: ${MISSING_BUILD}`));
    request.send();
  });
}

/**
 * @param {object} options
 * @param {(text: string, kind?: string) => void} [options.log]
 * @param {Record<string, string>} [options.pageEnv] process.env contents
 * @param {Record<string, string>} [options.goEnv] extra arduino-cli environment
 * @param {string} [options.wasmUrl] where arduino-cli.wasm lives
 * @param {string} [options.toolsBase] prefix for the toolchain assets, for a
 *   page that does not sit at the site root
 * @param {string} [options.database] IndexedDB database name
 * @param {string} [options.cwd]
 * @param {(context: { fs: object, path: object }) => Promise<void>} [options.prepare]
 *   write anything the CLI must find at start
 * @returns {Promise<{ shim: object, cli: object }>}
 */
export async function startPageCLI({
  log = () => undefined,
  pageEnv = { HOME: "/home/arduino", TMPDIR: "/tmp", PATH: "/bin" },
  goEnv = {},
  wasmUrl = "arduino-cli.wasm",
  toolsBase = "",
  database = "arduino-wasm",
  cwd = "/home/arduino",
  prepare,
} = {}) {
  const backend = globalThis.indexedDB ? new IdbBackend(database) : new MemoryBackend();
  if (!globalThis.indexedDB) {
    log("no IndexedDB here; files are kept in memory only", "err");
  }
  const shim = createNodeFS({
    backend,
    env: pageEnv,
    stdout: text => log(text),
    stderr: text => log(text, "err"),
    cwd,
  });
  await shim.ready();
  globalThis.fs = shim.fs;
  globalThis.path = shim.path;
  globalThis.process = shim.process;

  // Before the CLI runs: a compile asks arduinoExec for every tool it wants, and
  // answering "not implemented on js" is only correct when the toolchain is
  // genuinely absent.
  installPageTools({ nodefs: shim, log, base: toolsBase });

  // A page that needs files on disk before the CLI reads them -- a settings file,
  // a sketch -- writes them through the shim here, after it is hydrated and
  // before the CLI's environment is frozen.
  if (prepare) {
    await prepare({ fs: shim.fs, path: shim.path });
  }

  if (typeof globalThis.Go !== "function") {
    throw new Error("wasm_exec.js did not run: globalThis.Go is not a constructor");
  }
  const go = new globalThis.Go();
  go.argv = ["arduino-cli"];
  go.env = { ...pageEnv, ...goEnv };
  // Read once, at startup: the Go js ABI copies the environment into linear
  // memory when the program starts, so this cannot be changed afterwards.
  go.exit = code => log(`the CLI exited with code ${code}`, "err");

  const ready = new Promise(resolve => {
    globalThis.arduinoCLIReady = resolve;
  });
  const { instance } = await WebAssembly.instantiate(await readWasm(wasmUrl), go.importObject);
  go.run(instance); // never settles; the Go program blocks on select {}
  await ready;
  return { shim, cli: globalThis.arduinoCLI };
}
