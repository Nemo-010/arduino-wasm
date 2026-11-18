// A serial upload tool opens a path like /dev/ttyACM0. nodefs must let that
// open succeed and route read/write/ioctl to a device object, so any tool
// compiled to wasm can use POSIX-style serial I/O without a plugin in JS.
import { createNodeFS, MemoryBackend } from "../web/nodefs.js";

let failures = 0;
const check = (ok, message, detail) => {
  console.log((ok ? "  ok  " : "FAIL  ") + message + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!ok) failures += 1;
};
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (error, value) => error ? reject(error) : resolve(value)));

const written = [];
let opened = 0, closed = 0;
const device = {
  open: async () => { opened += 1; },
  write: async (buffer, offset, length) => {
    written.push(...buffer.subarray(offset, offset + length));
    return length;
  },
  read: async (buffer, offset, length) => {
    const source = Uint8Array.from([0x14, 0x10]);
    buffer.set(source.subarray(0, length), offset);
    return Math.min(length, source.length);
  },
  ioctl: async (request) => request === 0x5401 ? 0 : -1,
  close: async () => { closed += 1; },
};

const shim = createNodeFS({
  backend: new MemoryBackend(),
  devices: new Map([["/dev/ttyACM0", device]]),
  cwd: "/home/arduino",
  stdout: () => {},
  stderr: () => {},
});
await shim.ready();
const fs = shim.fs;

const fd = await call(fs.open, "/dev/ttyACM0", "r+", 0o666);
check(opened === 1, "opening the device called its open hook", String(opened));
const stat = await call(fs.fstat, fd);
check(stat.size === 0 && stat.isFile(), "the device looks like a character file to stat", JSON.stringify(stat));

const out = new TextEncoder().encode("AT?");
const count = await call(fs.write, fd, out, 0, out.length, null);
check(count === out.length, "the tool's write reached the device", String(count));
check(String.fromCharCode(...written) === "AT?", "the bytes are the ones the tool wrote", JSON.stringify(written));

const input = new Uint8Array(8);
const got = await call(fs.read, fd, input, 0, input.length, null);
check(got === 2 && input[0] === 0x14 && input[1] === 0x10, "the device's reply reached the tool", JSON.stringify([...input.subarray(0, got)]));

const ioctl = await call(fs.ioctl, fd, 0x5401, 0);
check(ioctl === 0, "termios ioctl is answered by the device", String(ioctl));

await call(fs.close, fd);
check(closed === 1, "close called the device hook", String(closed));

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
