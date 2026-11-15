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

export function installPageTools({ nodefs, log } = {}) {
  const avr = createAvrAssets({
    load: makeXhrRead(AVR_TOOLS),
    importModule: importFrom(AVR_TOOLS),
  });
  const arm = createArmAssets({
    load: makeXhrRead(ARM_TOOLS),
    importModule: importFrom(ARM_TOOLS),
  });
  globalThis.arduinoExec = createExec({
    nodefs,
    log,
    createDriver: (options) => createPageDriver({ ...options, avr, arm }),
  });
  return { avr, arm, exec: globalThis.arduinoExec };
}
