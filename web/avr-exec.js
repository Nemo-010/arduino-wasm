// The AVR toolchain behind the exec seam. The plumbing is in exec.js; this only
// names which driver answers a command line.

import { createAvrDriver } from "./avr-driver.js";
import { createExec, createVfsAccess } from "./exec.js";

export { createVfsAccess };

export function createAvrExec(options) {
  return createExec({ ...options, createDriver: createAvrDriver });
}

export function installAvrExec(options) {
  globalThis.arduinoExec = createAvrExec(options);
  return globalThis.arduinoExec;
}
