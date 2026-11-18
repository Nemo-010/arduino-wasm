// The generic upload-tool driver.
//
// arduino-cli does not know about WebUSB or WebSerial. It expands the board's
// upload recipe and hands the resulting command line to the same exec seam a
// compile uses. This module routes that command to a flasher registered for
// the tool's name, with a uniform interface:
//
//   flasher({ args, hex, port, readFile, log }) -> { code, stdout, stderr, files }
//
// Adding support for a board means registering the tool its platform declares,
// not changing the CLI bridge or this dispatcher. The selected port arrives in
// `globalThis.__arduinoUploadPort`, published by the Upload RPC.
//
// No flasher is built in: a page installs the ones it ships. An unregistered
// tool fails with its own name rather than being silently treated as a
// compiler, which is how every upload tool used to end up in the AVR driver.

import { basename } from "./tool-common.js";

// Arduino's -Uflash:w:<path>:i is common, but platforms also pass a bare path
// or a -U with a different memory name. Read the first path that exists and
// looks like a firmware image; the flasher gets the args too if it needs more.
export function firmwarePath(args) {
  for (const token of args.slice(1)) {
    const match = /(?:^|:)([^:\s]+\.(?:hex|bin|elf))(?:i|:|$)/i.exec(token);
    if (match) return match[1];
    if (/\.(hex|bin|elf)$/i.test(token)) return token;
  }
  return null;
}

export function createFlashDriver({ flashers = {}, readFile, log = () => {} }) {
  const drivers = new Map(Object.entries(flashers).map(([name, entry]) => [basename(name), entry]));
  const entryFor = (name) => {
    const entry = drivers.get(basename(name));
    return entry && typeof entry === "object" && typeof entry.run === "function"
      ? entry
      : entry && { run: entry };
  };
  return {
    register(name, fn) {
      drivers.set(basename(name), fn);
    },
    supports(tool, request) {
      const entry = entryFor(tool);
      if (!entry) return false;
      return entry.supports ? entry.supports(request) : true;
    },
    async run(request) {
      const args = request.args || [];
      const tool = basename(args[0] || "");
      const entry = entryFor(tool);
      const flasher = entry && entry.run;
      if (!flasher || (entry.supports && !entry.supports(request))) {
        return {
          code: 1,
          stdout: "",
          stderr: "no flash driver registered for " + tool + "\n",
          files: [],
        };
      }
      const path = firmwarePath(args);
      let hex = null;
      if (path && readFile) {
        hex = await readFile(path);
      }
      if (!hex) {
        return {
          code: 1,
          stdout: "",
          stderr: "upload tool " + tool + " has no readable firmware image in " + String(path) + "\n",
          files: [],
        };
      }
      const port = globalThis.__arduinoUploadPort || null;
      log("flash " + tool + " -> " + String(port && port.address) + " (" + hex.length + " bytes)");
      return flasher({ args, path, hex, port, readFile, log });
    },
  };
}
