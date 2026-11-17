// AVR flasher against a fake WebSerial STK500v1 bootloader.
//
// The fake speaks the same command/response protocol a real Uno bootloader
// does: three syncs, a signature read, device setup, enter programming mode,
// address/page writes, leave programming mode. It records the pages so the
// test can prove the firmware bytes actually crossed the port.
import { createAvrFlash } from "../web/flash-avr.js";

const SIGNATURE = [0x1e, 0x95, 0x0f];
const memory = new Map();
const commands = [];

function fakePort() {
  let pending = [];
  return {
    opened: false,
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    get readable() {
      return new ReadableStream({
        pull(controller) {
          if (pending.length) {
            controller.enqueue(Uint8Array.from(pending.splice(0)));
          }
        },
      });
    },
    get writable() {
      return new WritableStream({
        write(bytes) {
          const cmd = Array.from(bytes);
          commands.push(cmd);
          const op = cmd[0];
          let reply = [0x14, 0x10]; // INSYNC, OK
          if (op === 0x75) reply = [0x14, ...SIGNATURE, 0x10];
          if (op === 0x64) {
            // STK_PROG_PAGE: length is bytes 2..3, type at 4, data after.
            const length = (cmd[2] << 8) | cmd[3];
            const data = cmd.slice(5, 5 + length);
            const address = lastAddress * 2;
            data.forEach((byte, i) => memory.set(address + i, byte));
          }
          if (op === 0x55) {
            lastAddress = cmd[1] | (cmd[2] << 8);
          }
          pending = reply;
        },
      });
    },
  };
}
let lastAddress = 0;

const hex = new TextEncoder().encode(
  ":0400000001020304F2\n" +
  ":0400040005060708DE\n" +
  ":00000001FF\n",
);

let failures = 0;
const check = (ok, msg, detail) => {
  console.log((ok ? "  ok  " : "FAIL  ") + msg + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!ok) failures += 1;
};

const flash = createAvrFlash({ portProvider: fakePort, signature: SIGNATURE, pageSize: 128 });
globalThis.__arduinoUploadPort = { address: "/dev/ttyACM0", protocol: "serial" };
let result;
try {
  result = await flash({ hex, port: globalThis.__arduinoUploadPort });
} catch (error) {
  console.log("flash threw:", error && error.stack ? error.stack : String(error));
  result = { code: 1, stderr: String(error) };
}
check(result.code === 0, "the AVR flasher completed", JSON.stringify(result));
check(commands.length >= 8, "the bootloader received the whole command sequence", String(commands.length));
check(commands.filter((c) => c[0] === 0x30).length === 3, "the three syncs were sent", String(commands.filter((c) => c[0] === 0x30).length));
check(commands.some((c) => c[0] === 0x75), "the signature was read");
check(commands.some((c) => c[0] === 0x50), "programming mode was entered");
const pages = commands.filter((c) => c[0] === 0x64);
check(pages.length === 1, "one page was programmed", String(pages.length));
const expected = [1, 2, 3, 4, 5, 6, 7, 8];
check(expected.every((byte, i) => memory.get(i) === byte), "the firmware bytes arrived at the device", JSON.stringify([...memory.entries()].sort((a,b)=>a[0]-b[0])));
check(commands.some((c) => c[0] === 0x51), "programming mode was left");

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
