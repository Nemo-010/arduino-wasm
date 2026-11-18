// nRF52 DFU-serial flasher against a fake bootloader.
//
// The firmware package is produced by this project's own `nrfutil dfu genpkg`
// port; the fake port decodes the SLIP framing, checks the CRC, records the
// payloads and answers each packet with an ACK. The test proves the whole DFU
// command sequence and that the firmware bytes arrive, without hardware.
import { genpkg } from "../web/nrfutil.js";
import { createNrfFlash } from "../web/flash-nrf.js";

const FRAME = 0xc0, ESC = 0xdb;
const packets = [];
let pending = [];

function decodeFrame(bytes) {
  const out = [];
  let started = false, escaped = false;
  for (const byte of bytes) {
    if (byte === FRAME) {
      if (started) break;
      started = true;
      continue;
    }
    if (!started) continue;
    if (escaped) {
      out.push(byte === 0xdc ? FRAME : byte === 0xdd ? ESC : byte);
      escaped = false;
    } else if (byte === ESC) escaped = true;
    else out.push(byte);
  }
  return out;
}

function fakePort() {
  return {
    opened: false,
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    get readable() {
      return new ReadableStream({ pull(controller) {
        if (pending.length) controller.enqueue(Uint8Array.from(pending.splice(0)));
      } });
    },
    get writable() {
      return new WritableStream({ write(bytes) {
        const decoded = decodeFrame(Array.from(bytes));
        if (decoded.length < 8) throw new Error("short DFU packet");
        const seq = decoded[0] & 7;
        // ACK frame: header carrying seq in bits 3..5, then three filler bytes.
        pending = [FRAME, seq << 3, 0, 0, 0, FRAME];
        packets.push(decoded.slice(4, -2));
      } });
    },
  };
}

const hex = new TextEncoder().encode(
  ":100000000102030405060708090A0B0C0D0E0F1068\n" +
  ":100010001112131415161718191A1B1C1D1E1F2058\n" +
  ":00000001FF\n",
);
const pkg = await genpkg(
  ["dfu", "genpkg", "--application", "/work/blink.hex", "--dev-type", "0x0052", "--sd-req", "0x0123", "/work/blink.zip"],
  { readFile: async (path) => (path === "/work/blink.hex" ? hex : null) },
);
if (pkg.code !== 0 || !pkg.files || !pkg.files.length) {
  console.log("FAILED to build DFU package:", JSON.stringify(pkg));
  process.exit(1);
}

let failures = 0;
const check = (ok, message, detail) => {
  console.log((ok ? "  ok  " : "FAIL  ") + message + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!ok) failures += 1;
};

const flash = createNrfFlash({ portProvider: fakePort });
let result;
try {
  result = await flash({ hex: pkg.files[0].data, path: "/work/blink.zip" });
} catch (error) {
  console.log("flash threw:", error && error.stack ? error.stack : String(error));
  result = { code: 1, stderr: String(error) };
}
check(result.code === 0, "the nRF DFU flasher completed", JSON.stringify(result));
const op = (p) => p[0] | (p[1] << 8) | (p[2] << 8) | (p[3] << 24);
check(packets.length >= 4, "start, init, data and stop packets were sent", String(packets.length));
check(op(packets[0]) === 3, "the first packet is START", String(op(packets[0])));
check(op(packets[1]) === 1, "the second packet is INIT", String(op(packets[1])));
check(packets.some((p) => op(p) === 4), "firmware DATA was sent", String(packets.filter((p) => op(p) === 4).length));
check(op(packets[packets.length - 1]) === 5, "the last packet is STOP", String(op(packets[packets.length - 1])));
const data = packets.filter((p) => op(p) === 4).flatMap((p) => p.slice(4));
const expected = Array.from({ length: 32 }, (_, i) => i + 1);
check(expected.every((byte, i) => data[i] === byte), "the firmware bytes arrived at the device", data.length + " bytes");

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
