// The page's toolchains, installed behind the one exec seam the CLI knows.
//
// Both are installed together because arduinoExec is a single global; which one
// answers is decided per call by the tool's name (see page-drivers.js). The
// readers are separate on purpose: the AVR and ARM asset sets both contain a
// file called sysroot.tar.gz, so one reader for both would hand the AVR driver
// an ARM sysroot.

import { createArmAssets } from "./arm-assets.js";
import { createAvrAssets } from "./avr-assets.js";
import { createExec } from "./exec.js";
import { createFlashDriver } from "./flash.js";
import { createAvrFlash } from "./flash-avr.js";
import { createEspFlash } from "./flash-esp.js";
import { createNrfFlash } from "./flash-nrf.js";
import { createPageDriver } from "./page-drivers.js";
import { makeXhrRead } from "./page-index.js";

export const AVR_TOOLS = "tools/avr/";
export const ARM_TOOLS = "tools/arm/";

function importFrom(directory) {
  return (name) => import(new URL(directory + name + ".mjs", document.baseURI).href);
}

// `base` is for a page that does not sit at the site root: the IDE's page lives
// in its own directory, and the toolchains are one level up. Everything below is
// resolved against the document's own URL, so the base is the only difference.
export function installPageTools({ nodefs, log, base = "" } = {}) {
  const avrDir = base + AVR_TOOLS;
  const armDir = base + ARM_TOOLS;
  const avr = createAvrAssets({
    load: makeXhrRead(avrDir),
    importModule: importFrom(avrDir),
  });
  const arm = createArmAssets({
    load: makeXhrRead(armDir),
    importModule: importFrom(armDir),
  });
  // One registry for every upload tool. A page can add more flashers with
  // `installFlashers({ name: fn })`; the AVR one is built in because the CLI
  // page ships the AVR platform. The driver reads firmware through the same
  // nodefs shim the compiler uses, so the hex is the one the CLI just built.
  const flash = createFlashDriver({
    readFile: async (path) => {
      const fs = nodefs.fs;
      const fd = await new Promise((resolve, reject) => fs.open(path, "r", 0o644, (e, v) => e ? reject(e) : resolve(v)));
      try {
        const stat = await new Promise((resolve, reject) => fs.fstat(fd, (e, v) => e ? reject(e) : resolve(v)));
        const bytes = new Uint8Array(stat.size);
        let at = 0;
        while (at < bytes.length) {
          const n = await new Promise((resolve, reject) => fs.read(fd, bytes, at, bytes.length - at, at, (e, v) => e ? reject(e) : resolve(v)));
          if (!n) break;
          at += n;
        }
        return bytes.subarray(0, at);
      } finally {
        await new Promise((resolve) => fs.close(fd, () => resolve()));
      }
    },
    log,
    flashers: {
      avrdude: createAvrFlash({
        log,
        portProvider: async () => globalThis.__arduinoSerialPort || undefined,
      }),
      "esptool.py": createEspFlash({
        log,
        portProvider: async () => globalThis.__arduinoSerialPort || undefined,
      }),
      esptool_py: createEspFlash({
        log,
        portProvider: async () => globalThis.__arduinoSerialPort || undefined,
      }),
      // The same tool also builds DFU packages (`dfu genpkg`); that step is
      // the ARM driver's existing port, so only `dfu serial` belongs here.
      nrfutil: (() => {
        const flashNrf = createNrfFlash({
          log,
          portProvider: async () => globalThis.__arduinoSerialPort || undefined,
        });
        return {
          supports: (request) => (request.args || []).includes("serial"),
          run: flashNrf,
        };
      })(),
    },
  });
  // Published for the page tests: a shipped page must prove which upload
  // tools it can actually answer, not just that the plugin files exist.
  globalThis.__flashTools = flash;
  globalThis.installFlashers = (more) => {
    for (const [name, fn] of Object.entries(more)) flash.register(name, fn);
  };
  globalThis.arduinoExec = createExec({
    nodefs,
    log,
    createDriver: (options) => createPageDriver({ ...options, avr, arm, flash }),
  });
  return { avr, arm, flash, exec: globalThis.arduinoExec };
}
