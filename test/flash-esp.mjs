// The Espressif plugin's registration surface. It covers every chip by
// delegating detection to esptool-js; this test does not claim a device flash
// (that needs hardware), only that the plugin is loadable and tool routing
// recognises the names a platform index declares.
import { createEspFlash, isEspTool } from "../web/flash-esp.js";

let failures = 0;
const check = (ok, message, detail) => {
  console.log((ok ? "  ok  " : "FAIL  ") + message + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!ok) failures += 1;
};

for (const name of ["esptool.py", "esptool_py", "/tools/esptool.py", "/home/arduino/tools/esptool_py/5.3.1/esptool.py"]) {
  check(isEspTool(name), "recognises " + name);
}
for (const name of ["avrdude", "arm-none-eabi-gcc", "bossac"]) {
  check(!isEspTool(name), "does not claim " + name);
}
const flash = createEspFlash({ portProvider: async () => null });
check(typeof flash === "function", "the plugin exposes a flasher function");

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
