// One exec seam, two toolchains.
//
// arduino-cli asks for a command by path, and the path names the tool. The ARM
// tools all carry the target triple, and the nRF52 DFU packer keeps its own
// name; everything else belongs to AVR. Routing on the name is what lets both
// platforms compile in one page through a single global.
//
// Each driver is built on first use and keeps its own sysroot: decompressing
// the ARM sysroot is 5 MB of work, and a page that only compiles AVR should
// never pay for it.

import { createArmDriver } from "./arm-driver.js";
import { createAvrDriver } from "./avr-driver.js";
import { basename } from "./tool-common.js";

export const ARM_TOOL = /^arm-none-eabi-|^(adafruit-)?nrfutil$/;

export function isArmTool(name) {
  return ARM_TOOL.test(name);
}

export function createPageDriver({ avr, arm, readFile, listDir, isDirectory, log }) {
  // Both factories are async: each stages a sysroot before it can answer
  // anything. The promise is cached rather than the driver, so two commands
  // that arrive together share one load instead of decompressing twice.
  let avrDriver = null;
  let armDriver = null;

  const build = (assets, factory) =>
    factory({ ...assets, readFile, listDir, isDirectory, log });

  return {
    async run(request) {
      const argv = request.args || [];
      const tool = basename(argv[0] || "");
      if (isArmTool(tool)) {
        if (!armDriver) armDriver = build(arm, createArmDriver);
        return (await armDriver).run(request);
      }
      if (!avrDriver) avrDriver = build(avr, createAvrDriver);
      return (await avrDriver).run(request);
    },
    toolchains: () => ({
      avr: avrDriver !== null,
      arm: armDriver !== null,
    }),
  };
}
