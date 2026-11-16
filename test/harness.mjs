// Test loader: runs web/arduino-cli.wasm under Node with the same filesystem
// shim the browser uses. No native fs is involved; the wasm only ever sees
// web/nodefs.js.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createNodeFS, MemoryBackend } from "../web/nodefs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "web");

export async function startCLI({ stdout, stderr, cwd = "/home/arduino", env = {}, debug = false, fetch, wasm: wasmFile } = {}) {
  const lines = [];
  const tee = (stream, sink) => (text) => {
    for (const line of text.split("\n")) {
      if (!line) continue;
      lines.push({ stream, line });
      sink?.(line);
    }
  };

  const shim = createNodeFS({
    debug,
    backend: new MemoryBackend(),
    stdout: tee("stdout", stdout),
    stderr: tee("stderr", stderr),
    cwd,
    // The page's own environment. `go.env` is set from the same values below, so
    // a module that reads `process.env` and the CLI see one environment.
    env: { HOME: "/home/arduino", TMPDIR: "/tmp", PATH: "/bin", ...env },
  });

  await shim.ready();

  if (fetch) globalThis.fetch = fetch;

  globalThis.fs = shim.fs;
  globalThis.path = shim.path;
  globalThis.process = shim.process;

  const require = createRequire(import.meta.url);
  require(path.join(web, "wasm_exec.js"));
  const Go = globalThis.Go;

  const go = new Go();
  go.argv = ["arduino-cli"];
  go.env = { HOME: cwd, TMPDIR: "/tmp", ...env };
  go.exit = (code) => {
    throw new Error("go exited with code " + code + "\n" + lines.slice(-20).map((l) => l.line).join("\n"));
  };

  const ready = new Promise((resolve) => {
    globalThis.arduinoCLIReady = resolve;
  });

  const wasm = await readFile(wasmFile || path.join(web, "arduino-cli.wasm"));
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  go.run(instance).catch((error) => {
    console.error("go.run rejected:", error);
  });
  await ready;

  return {
    call,
    callBinary,
    shim,
    lines,
    dump() {
      return lines.map((l) => `${l.stream}: ${l.line}`).join("\n");
    },
  };

  // callBinary carries the same events with protobuf binary instead of JSON,
  // which is what the IDE's generated client sends and expects. The payload
  // stays base64 so the caller can hand it to the generated message class.
  //
  // The third argument is the event observer itself, because that is the seam
  // `ide/inpage/cli-client.mjs` was written against: it forwards each event to
  // the caller as the CLI produces it. There is no default timeout -- a core
  // install through the IDE runs for minutes, and the bridge always ends a call
  // with `done` or `error`.
  function callBinary(method, requestBase64, options) {
    const onEvent = typeof options === "function" ? options : options && options.onEvent;
    const timeoutMs = (options && typeof options === "object" && options.timeoutMs) || 0;
    return new Promise((resolve, reject) => {
      const events = [];
      const timer = timeoutMs ? setTimeout(() => {
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs) : null;
      globalThis.arduinoCLI.callBinary(method, requestBase64, (raw) => {
        const event = JSON.parse(raw);
        events.push(event);
        onEvent?.(event);
        if (event.type === "error") {
          clearTimeout(timer);
          const error = new Error(`${method}: ${event.message}`);
          if (typeof event.code === "number") error.code = event.code;
          error.events = events;
          reject(error);
        } else if (event.type === "done") {
          clearTimeout(timer);
          resolve(events);
        }
      });
    });
  }

  function call(method, request, { timeoutMs = 120000, onEvent } = {}) {
    return new Promise((resolve, reject) => {
      const events = [];
      const timer = setTimeout(() => {
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      globalThis.arduinoCLI.call(method, JSON.stringify(request ?? {}), (raw) => {
        const event = JSON.parse(raw);
        events.push(event);
        onEvent?.(event);
        if (event.type === "error") {
          clearTimeout(timer);
          const error = new Error(`${method}: ${event.message}`);
          if (typeof event.code === "number") error.code = event.code;
          error.events = events;
          reject(error);
        } else if (event.type === "done") {
          clearTimeout(timer);
          resolve(events);
        }
      });
    });
  }
}
