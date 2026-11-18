// The Espressif plugin's call chain: with a fake WebSerial port that never
// answers the ROM bootloader, esptool-js must be the component that fails.
// This does not claim a device flash; it proves the plugin reaches the library
// rather than stopping at port selection or registration.
import { createEspFlash } from "../web/flash-esp.js";

let failures = 0;
const check = (ok, message, detail) => {
  console.log((ok ? "  ok  " : "FAIL  ") + message + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!ok) failures += 1;
};

const port = {
  opened: false,
  getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
  setSignals: async () => {},
  async open() { this.opened = true; },
  async close() { this.opened = false; },
  get readable() { return new ReadableStream({ pull() {} }); },
  get writable() { return new WritableStream({ write() {} }); },
};

const hex = new TextEncoder().encode(":00000001FF\n");
const flash = createEspFlash({ portProvider: async () => port });
let error = null;
try {
  await flash({ hex, path: "/work/blink.bin", args: ["esptool.py", "write_flash", "/work/blink.bin"] });
} catch (thrown) {
  error = String(thrown && thrown.message || thrown);
}
check(port.opened === true, "the plugin opened the WebSerial port");
check(error !== null, "the ROM handshake failed on a silent device", String(error));
check(!/no WebSerial port/.test(String(error)), "the failure came from esptool-js, not port selection", String(error));

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
