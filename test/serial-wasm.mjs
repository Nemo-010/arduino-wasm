// A real wasm tool reading from WebSerial through a POSIX path.
//
// The tool is compiled from test/fixtures/serial-tool.c with scripts/serial-shim.c
// by scripts/build-serial-tool.py and committed so CI needs no Emscripten. It
// opens /dev/ttyACM0 and calls read(); the shim suspends the C caller until the
// page's WebSerial device answers. No JavaScript knows what the tool does with
// the bytes: that is what makes the route generic for a new core's tool.
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installEmscriptenSerial } from "../web/serial-emscripten.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const moduleUrl = pathToFileURL(join(root, "test/fixtures/serial-tool.mjs")).href;
const { default: createTool } = await import(moduleUrl);
const wasm = await (await import("node:fs/promises")).readFile(join(root, "test/fixtures/serial-tool.wasm"));

let failures = 0;
const check = (ok, message, detail) => {
  console.log((ok ? "  ok  " : "FAIL  ") + message + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!ok) failures += 1;
};

let opened = 0;
const port = {
  opened: false,
  async open() { this.opened = true; opened += 1; },
  async close() { this.opened = false; },
  get readable() {
    return new ReadableStream({ pull(controller) {
      controller.enqueue(Uint8Array.from([0x14, 0x10]));
    } });
  },
  get writable() { return new WritableStream({ write() {} }); },
};

let output = "";
const instance = await createTool({ wasmBinary: wasm, noInitialRun: true,
  print: (line) => { output += line + "\n"; },
  printErr: (line) => { output += line + "\n"; },
});
const installed = installEmscriptenSerial(instance, port);
check(installed.paths.includes("/dev/ttyACM0"), "the tool's FS has a serial device", installed.paths.join(","));
await instance.callMain([]);
check(opened === 1, "opening the path opened WebSerial", String(opened));
check(globalThis.__arduinoSerialReads > 0, "the tool read through the async bridge", String(globalThis.__arduinoSerialReads));

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
