// The generic upload-tool dispatcher: any platform's declared upload tool
// routes to a registered flasher with the compiled firmware and the selected
// port. No board or chip family is named here.
import { createFlashDriver, firmwarePath } from "../web/flash.js";

let failures = 0;
function check(condition, message, detail) {
  console.log((condition ? "  ok  " : "FAIL  ") + message + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!condition) failures += 1;
}

const hexPath = "/home/arduino/.cache/arduino/sketches/ABC/sketch.ino.hex";
const hex = new TextEncoder().encode(":00000001FF\n");
globalThis.__arduinoUploadPort = { address: "/dev/ttyACM0", protocol: "serial", label: "dummy" };

check(
  firmwarePath(["tool", "-Uflash:w:" + hexPath + ":i"]) === hexPath,
  "the flash path is read from Arduino's -Uflash recipe",
  firmwarePath(["tool", "-Uflash:w:" + hexPath + ":i"]),
);

const seen = [];
const driver = createFlashDriver({
  readFile: async (path) => (path === hexPath ? hex : null),
  flashers: {
    avrdude: async (request) => {
      seen.push(request);
      return { code: 0, stdout: "flash ok", stderr: "", files: [] };
    },
    "esptool.py": async (request) => {
      seen.push(request);
      return { code: 0, stdout: "esp ok", stderr: "", files: [] };
    },
  },
});

const result = await driver.run({
  args: ["/usr/bin/avrdude", "-Uflash:w:" + hexPath + ":i", "-patmega328p"],
});
check(result.code === 0 && result.stdout === "flash ok", "a registered tool answers", JSON.stringify(result));
check(seen.length === 1, "the flasher was called once", String(seen.length));
check(seen[0] && seen[0].hex === hex, "the flasher got the compiled hex", seen[0] && seen[0].hex && seen[0].hex.length);
check(seen[0] && seen[0].port.address === "/dev/ttyACM0", "the flasher got the selected port", JSON.stringify(seen[0] && seen[0].port));
check(seen[0] && seen[0].path === hexPath, "the flasher got the firmware path", seen[0] && seen[0].path);

const esp = await driver.run({ args: ["/tools/esptool.py", "write_flash", hexPath] });
check(esp.code === 0 && esp.stdout === "esp ok", "a second, unrelated tool routes independently", JSON.stringify(esp));
check(seen.length === 2 && seen[1].args[0].endsWith("esptool.py"), "the right flasher was selected by tool name", JSON.stringify(seen[1].args));

const unknown = await driver.run({ args: ["/tools/bossac", "-Uflash:w:" + hexPath + ":i"] });
check(unknown.code === 1 && /bossac/.test(unknown.stderr), "an unregistered tool names itself instead of falling through", JSON.stringify(unknown));
check(seen.length === 2, "an unregistered tool calls no flasher", String(seen.length));

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
