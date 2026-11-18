// nRF52 DFU-serial flasher behind the generic upload-tool dispatcher.
//
// The CLI's recipe is `nrfutil dfu serial -pkg <zip> -p <port>`: the firmware
// is a DFU package produced by our own `nrfutil dfu genpkg` port. This plugin
// ports the serial transport from adafruit-nrfutil 0.5.3.post16 (Nordic's
// Apache/BSD-licensed code): SLIP-framed HCI packets, CRC-16, the start/init/
// data/stop sequence and ACK checking. It talks to a WebSerial port supplied
// by the page; no host process is involved.

import { unzip } from "./zip.js";

const INIT = 1;
const START = 3;
const DATA = 4;
const STOP = 5;
const MODE_APPLICATION = 4;
const MAX_PACKET = 512;
const FRAME = 0xc0;
const ESC = 0xdb;

function crc16(bytes, crc = 0xffff) {
  for (const byte of bytes) {
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= byte;
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00ff) << 4) << 1;
  }
  return crc & 0xffff;
}

function int32(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function encodeSlip(bytes) {
  const out = [FRAME];
  for (const byte of bytes) {
    if (byte === FRAME) out.push(ESC, 0xdc);
    else if (byte === ESC) out.push(ESC, 0xdd);
    else out.push(byte);
  }
  out.push(FRAME);
  return Uint8Array.from(out);
}

function hciPacket(sequence, payload) {
  const dip = 1;
  const reliable = 1;
  const ptype = 14;
  const length = payload.length;
  const header = [
    sequence | (((sequence + 1) % 8) << 3) | (dip << 6) | (reliable << 7),
    ptype | ((length & 0x0f) << 4),
    (length & 0x0ff0) >> 4,
  ];
  header.push((~(header[0] + header[1] + header[2]) + 1) & 0xff);
  const body = Uint8Array.from([...header, ...payload]);
  const checksum = crc16(body);
  return encodeSlip(Uint8Array.from([...body, checksum & 0xff, (checksum >> 8) & 0xff]));
}

export function createNrfFlash({ portProvider } = {}) {
  async function getPort() {
    if (portProvider) {
      const port = await portProvider();
      if (port) return port;
    }
    const serial = globalThis.navigator?.serial;
    if (!serial) throw new Error("WebSerial is not available in this browser");
    const ports = await serial.getPorts();
    return ports[0] || serial.requestPort();
  }

  return async function flashNrf({ hex, path, log = () => {} }) {
    const entries = unzip(hex);
    const manifestName = [...entries.keys()].find((name) => name.endsWith("manifest.json"));
    if (!manifestName) throw new Error("DFU package has no manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(entries.get(manifestName).data));
    const image = manifest.manifest.application;
    const bin = entries.get(image.bin_file);
    const dat = entries.get(image.dat_file);
    if (!bin || !dat) throw new Error("DFU package is missing its bin or dat file");

    const port = await getPort();
    if (!port) throw new Error("no WebSerial port was selected for upload");
    await port.open({ baudRate: 115200 });
    const writer = port.writable.getWriter();
    const reader = port.readable.getReader();
    let sequence = 0;
    let lastAck = null;
    try {
      async function send(payload) {
        const packet = hciPacket(sequence, payload);
        sequence = (sequence + 1) % 8;
        await writer.write(packet);
        // ACK is a two-C0-framed packet; its first header byte carries the
        // sequence number in bits 3..5, like the request.
        const deadline = Date.now() + 5000;
        let bytes = [];
        while (Date.now() < deadline) {
          const frames = bytes.filter((b) => b === FRAME).length;
          if (frames >= 2) break;
          const { value, done } = await reader.read();
          if (done) throw new Error("serial port closed during DFU");
          if (value) bytes.push(...value);
        }
        // Decode the first complete frame between the leading and trailing C0.
        const decoded = [];
        let escaped = false;
        let started = false;
        for (const byte of bytes) {
          if (byte === FRAME) {
            if (started) break;
            started = true;
            continue;
          }
          if (!started) continue;
          if (escaped) {
            decoded.push(byte === 0xdc ? FRAME : byte === 0xdd ? ESC : byte);
            escaped = false;
          } else if (byte === ESC) {
            escaped = true;
          } else {
            decoded.push(byte);
          }
        }
        if (decoded.length < 4) throw new Error("no DFU acknowledgement from " + String(path));
        const ack = (decoded[0] >> 3) & 0x07;
        if (lastAck !== null && ack !== (lastAck + 1) % 8) {
          throw new Error("nRF DFU unexpected ACK " + ack + " after " + lastAck);
        }
        lastAck = ack;
      }

      await send(Uint8Array.from([...int32(START), ...int32(MODE_APPLICATION), ...int32(0), ...int32(0), ...int32(bin.data.length)]));
      await send(Uint8Array.from([...int32(INIT), ...dat.data, 0, 0]));
      for (let at = 0; at < bin.data.length; at += MAX_PACKET) {
        const chunk = bin.data.subarray(at, at + MAX_PACKET);
        await send(Uint8Array.from([...int32(DATA), ...chunk]));
        log("nRF DFU: " + Math.min(at + chunk.length, bin.data.length) + "/" + bin.data.length);
      }
      await send(Uint8Array.from(int32(STOP)));
      return {
        code: 0,
        stdout: "DFU complete: " + bin.data.length + " bytes\n",
        stderr: "",
        files: [],
      };
    } finally {
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    }
  };
}
