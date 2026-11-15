// The ARM toolchain behind the exec seam, for nRF52 boards.

import { createArmDriver } from "./arm-driver.js";
import { createExec } from "./exec.js";

export function createArmExec(options) {
  return createExec({ ...options, createDriver: createArmDriver });
}

export function installArmExec(options) {
  globalThis.arduinoExec = createArmExec(options);
  return globalThis.arduinoExec;
}
