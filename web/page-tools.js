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
  globalThis.arduinoExec = createExec({
    nodefs,
    log,
    createDriver: (options) => createPageDriver({ ...options, avr, arm }),
  });
  return { avr, arm, exec: globalThis.arduinoExec };
}
