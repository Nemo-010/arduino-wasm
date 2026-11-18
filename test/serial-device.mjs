// A WebSerial port becomes a POSIX /dev/tty* path in the page filesystem.
// This is the generic device layer any wasm upload tool uses: no flasher in JS.
import { createNodeFS, MemoryBackend } from "../web/nodefs.js";
import { createSerialDevices } from "../web/serial-device.js";

let failures = 0;
const check = (ok, message, detail) => {
  console.log((ok ? "  ok  " : "FAIL  ") + message + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!ok) failures += 1;
};
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (e, v) => e ? reject(e) : resolve(v)));

const written = [];
let opened = 0, closed = 0;
const port = {
  opened: false,
  getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0043 }),
  async open() { this.opened = true; opened += 1; },
  async close() { this.opened = false; closed += 1; },
  get readable() {
    return new ReadableStream({ pull(controller) {
      controller.enqueue(Uint8Array.from([0x14, 0x10]));
    } });
  },
  get writable() {
    return new WritableStream({ write(bytes) { written.push(...bytes); } });
  },
};

const devices = createSerialDevices(port);
check(devices.has("/dev/ttyACM0"), "a POSIX serial path is registered", [...devices.keys()].join(", "));
const shim = createNodeFS({ backend: new MemoryBackend(), devices, cwd: "/" });
await shim.ready();
const fd = await call(shim.fs.open, "/dev/ttyACM0", "r+", 0o666);
check(opened === 1 && port.opened, "opening the path opened the WebSerial port", String(opened));
const out = new TextEncoder().encode("avrdude");
const count = await call(shim.fs.write, fd, out, 0, out.length, null);
check(count === out.length && String.fromCharCode(...written) === "avrdude", "the tool's bytes went to WebSerial", JSON.stringify(written));
const input = new Uint8Array(4);
const got = await call(shim.fs.read, fd, input, 0, 4, null);
check(got === 2 && input[0] === 0x14, "the device's reply came back through read", JSON.stringify([...input.subarray(0, got)]));
await call(shim.fs.close, fd);
check(closed === 1, "close closed the WebSerial port", String(closed));

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
