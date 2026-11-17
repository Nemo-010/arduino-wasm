// AVR flasher behind the generic upload-tool dispatcher.
//
// This is one plugin, not the architecture: the dispatcher in flash.js routes
// any tool name to any flasher. This one implements STK500v1, the protocol
// avrdude uses with the Arduino Uno's USB-serial bootloader. It talks to a
// WebSerial port supplied by the page, never to a host process.
//
// The command line the CLI hands over carries the hex path; the port comes
// from the Upload RPC via __arduinoUploadPort. The board's signature and page
// size are the Uno defaults here, substitutable by the caller for another AVR.

import { parseHex } from "./nrfutil.js";

const SYNC = 0x30;
const SET_DEVICE = 0x42;
const ENTER_PROGMODE = 0x50;
const LOAD_ADDRESS = 0x55;
const PROG_PAGE = 0x64;
const LEAVE_PROGMODE = 0x51;
const READ_SIGN = 0x75;
const EOP = 0x20;
const INSYNC = 0x14;
const OK = 0x10;
const NOSYNC = 0x15;

function command(bytes, expect) {
  return { bytes: Uint8Array.from([...bytes, EOP]), expect: Uint8Array.from(expect) };
}

export function createAvrFlash({ portProvider, signature = [0x1e, 0x95, 0x0f], pageSize = 128, baudRate = 115200 } = {}) {
  async function openPort() {
    if (portProvider) return portProvider();
    const serial = globalThis.navigator?.serial;
    if (!serial) throw new Error("WebSerial is not available in this browser");
    const ports = await serial.getPorts();
    return ports[0] || serial.requestPort();
  }

  // A WebSerial reader/writer pair with the small command/response protocol
  // STK500 needs. Reads accumulate until the expected response bytes arrive.
  async function exchange(writer, readerState, cmd) {
    await writer.write(cmd.bytes);
    const target = cmd.expect;
    let seen = [];
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      while (readerState.buffer.length < target.length && Date.now() < deadline) {
        const { value, done } = await readerState.reader.read();
        if (done) throw new Error("serial port closed during flash");
        if (value) readerState.buffer.push(...value);
      }
      const at = readerState.buffer.findIndex((byte, index) =>
        byte === target[0] && target.every((want, offset) => readerState.buffer[index + offset] === want));
      if (at >= 0) {
        const response = readerState.buffer.splice(0, at + target.length);
        return Uint8Array.from(response);
      }
      // Drop a stale NOSYNC and try again; avrdude sends several dummy syncs.
      const nosync = readerState.buffer.indexOf(NOSYNC);
      if (nosync >= 0) readerState.buffer.splice(nosync, 1);
      else if (readerState.buffer.length > 64) readerState.buffer.shift();
    }
    throw new Error("serial flash timed out waiting for " + Array.from(target).map((b) => b.toString(16)).join(" "));
  }

  return async function flashAvr({ hex, port, log = () => {} }) {
    const device = await openPort();
    if (!device) throw new Error("no WebSerial port was selected for upload");
    await device.open({ baudRate });
    const writer = device.writable.getWriter();
    const reader = device.readable.getReader();
    const state = { reader, buffer: [] };
    const lines = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        await exchange(writer, state, command([SYNC], [INSYNC, OK]));
      }
      const identity = await exchange(writer, state,
        command([READ_SIGN], [INSYNC, ...signature, OK]));
      const read = Array.from(identity).slice(1, 1 + signature.length);
      if (!signature.every((byte, i) => byte === read[i])) {
        throw new Error("device signature " + read.map((b) => b.toString(16)).join(" ") +
          " does not match " + signature.map((b) => b.toString(16)).join(" "));
      }
      const deviceCode = Uint8Array.from([0x44, 0x00, pageSize >> 8, pageSize & 0xff, 0x00]);
      await exchange(writer, state, command([SET_DEVICE, ...deviceCode], [INSYNC, OK]));
      await exchange(writer, state, command([ENTER_PROGMODE], [INSYNC, OK]));

      const text = new TextDecoder().decode(hex);
      const image = parseHex(text);
      const addresses = [...image.keys()].sort((a, b) => a - b);
      if (!addresses.length) throw new Error("the hex has no data records");
      for (let offset = 0; offset < addresses.length; offset += pageSize) {
        const page = addresses.slice(offset, offset + pageSize).map((address) => image.get(address));
        const wordAddress = (addresses[offset] >> 1) & 0xffff;
        await exchange(writer, state, command(
          [LOAD_ADDRESS, wordAddress & 0xff, (wordAddress >> 8) & 0xff], [INSYNC, OK]));
        await exchange(writer, state, command(
          [PROG_PAGE, 0x00, (page.length >> 8) & 0xff, page.length & 0xff, 0x01, ...page], [INSYNC, OK]));
      }
      await exchange(writer, state, command([LEAVE_PROGMODE], [INSYNC, OK]));
      lines.push("wrote " + addresses.length + " bytes to " + (port?.address || "the selected port"));
    } finally {
      reader.releaseLock();
      writer.releaseLock();
      await device.close();
    }
    return { code: 0, stdout: lines.join("\n") + "\n", stderr: "", files: [] };
  };
}
