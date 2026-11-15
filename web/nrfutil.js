// adafruit-nrfutil's `dfu genpkg`: a stdlib-only port of the packaging step.
//
// The Seeed nRF52 platform runs this after objcopy to turn the .hex into the
// .zip the Adafruit bootloader's DFU accepts. It is a Python program, so it
// cannot run in a page, and leaving it out would leave the compile without its
// declared output. The format is small and fixed, so it is reproduced here:
//
//   * the application .bin is the .hex flattened from its lowest to its
//     highest address, gaps filled with 0xFF and the length rounded up to a
//     word, which is what nordicsemi.dfu.nrfhex does;
//   * the .dat init packet is the little-endian struct
//     dev_type, dev_revision, app_version, count, sd_req[count], crc16;
//   * manifest.json is the protobuf JSON of the manifest, which sorts keys and
//     indents by four;
//   * the zip stores its three entries uncompressed.
//
// test/nrfutil.mjs compares every entry against the output of the real
// adafruit-nrfutil, and compares the .dat and .bin byte for byte.

const INIT_PACKET_USES_CRC16 = 0;
const DEVICE_REVISION_DEFAULT = 0xffff;
const APP_VERSION_DEFAULT = 0xffffffff;

// nordicsemi.dfu.crc16.calc_crc16, carried over as written: the nibble swaps
// are what the bootloader checks, so this is not a general-purpose CRC16.
export function crc16(data, crc = 0xffff) {
  for (const byte of data) {
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= byte;
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00ff) << 4) << 1;
    // Only the low 16 bits reach the next round, so masking here is not a
    // change of the algorithm, it keeps the number in a machine word.
    crc &= 0xffff;
  }
  return crc & 0xffff;
}

// Intel HEX in, address -> byte map out. Records other than data and end of
// file are honoured: 02 sets the segment base, 04 the upper linear address.
export function parseHex(text) {
  const bytes = new Map();
  let base = 0;
  let sawEnd = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith(":")) throw new Error("hex: line does not start with ':': " + line);
    const hex = line.slice(1);
    if (hex.length < 10 || hex.length % 2) throw new Error("hex: record has a bad length: " + line);
    const fields = [];
    for (let index = 0; index < hex.length; index += 2) fields.push(parseInt(hex.slice(index, index + 2), 16));
    if (fields.some((value) => Number.isNaN(value))) throw new Error("hex: record is not hex: " + line);
    const count = fields[0];
    const address = (fields[1] << 8) | fields[2];
    const type = fields[3];
    const payload = fields.slice(4, 4 + count);
    if (payload.length !== count) throw new Error("hex: record is shorter than it declares: " + line);
    const checksum = fields[4 + count];
    const sum = fields.slice(0, 4 + count).reduce((total, value) => total + value, 0) + checksum;
    if ((sum & 0xff) !== 0) throw new Error("hex: record checksum does not add up: " + line);
    if (type === 0x00) {
      for (let index = 0; index < payload.length; index += 1) bytes.set(base + address + index, payload[index]);
    } else if (type === 0x01) {
      sawEnd = true;
    } else if (type === 0x02) {
      base = (((payload[0] << 8) | payload[1]) << 4) >>> 0;
    } else if (type === 0x04) {
      base = (((payload[0] << 8) | payload[1]) << 16) >>> 0;
    }
  }
  if (!sawEnd) throw new Error("hex: no end-of-file record");
  if (bytes.size === 0) throw new Error("hex: no data records");
  return bytes;
}

// nRFHex.tobinfile: start at the lowest address, run to the highest, fill the
// gaps with 0xFF, then round the length up to four bytes.
export function toBin(bytes) {
  const addresses = [...bytes.keys()];
  const low = Math.min(...addresses);
  const high = Math.max(...addresses);
  const raw = new Uint8Array(high - low + 1).fill(0xff);
  for (const [address, value] of bytes) raw[address - low] = value;
  const padded = Math.ceil(raw.length / 4) * 4;
  if (padded === raw.length) return raw;
  const out = new Uint8Array(padded).fill(0xff);
  out.set(raw);
  return out;
}

// Packet.generate_packet for dfu_version 0.5: the fields present are
// DEVICE_TYPE, DEVICE_REVISION, APP_VERSION, REQUIRED_SOFTDEVICES_ARRAY and
// NORDIC_PROPRIETARY_OPT_DATA_FIRMWARE_CRC16, in that order.
export function initPacket({ deviceType, deviceRevision, appVersion, softdeviceReq, firmwareCrc16 }) {
  const out = [];
  const push16 = (value) => out.push(value & 0xff, (value >> 8) & 0xff);
  push16(deviceType);
  push16(deviceRevision);
  out.push(appVersion & 0xff, (appVersion >>> 8) & 0xff, (appVersion >>> 16) & 0xff, (appVersion >>> 24) & 0xff);
  push16(softdeviceReq.length);
  for (const id of softdeviceReq) push16(id);
  push16(firmwareCrc16);
  return Uint8Array.from(out);
}

function jsonText(value, depth = 0) {
  const pad = "    ".repeat(depth + 1);
  const close = "    ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map((item) => pad + jsonText(item, depth + 1)).join(",\n") + "\n" + close + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{\n" + keys.map((key) => pad + JSON.stringify(key) + ": " + jsonText(value[key], depth + 1)).join(",\n")
      + "\n" + close + "}";
  }
  return JSON.stringify(value);
}

// The zip is written by hand because a page has no zip library and the entries
// are stored rather than deflated: three small files, and no dependency.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS timestamp: the format has no timezone, so a fixed date makes the archive
// reproducible. A bootloader reads the entries, not the date.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const data = entry.data;
    const checksum = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0, true);
    header.setUint16(8, 0, true);
    header.setUint16(10, DOS_TIME, true);
    header.setUint16(12, DOS_DATE, true);
    header.setUint32(14, checksum, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);
    locals.push(new Uint8Array(header.buffer), name, data);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, DOS_TIME, true);
    record.setUint16(14, DOS_DATE, true);
    record.setUint32(16, checksum, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint16(30, 0, true);
    record.setUint16(32, 0, true);
    record.setUint16(34, 0, true);
    record.setUint16(36, 0, true);
    record.setUint32(38, 0, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...central, new Uint8Array(end.buffer)];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function parseNumber(text) {
  const trimmed = String(text).trim();
  if (/^0x/i.test(trimmed)) return parseInt(trimmed.slice(2), 16);
  return parseInt(trimmed, 10);
}

// The command the platform runs:
//   adafruit-nrfutil dfu genpkg --dev-type 0x0052 --sd-req 0x0123 \
//     --application <in.hex> <out.zip>
// readFile is the VFS's, which is async: awaiting it here means the driver can
// answer with this result directly.
export async function genpkg(argv, { readFile }) {
  // The CLI passes the subcommand words too: "dfu genpkg ...". Anything else
  // is refused by name rather than silently ignored.
  const words = [...argv];
  if (words[0] === "dfu") words.shift();
  if (words[0] === "genpkg") words.shift();
  else return { code: 1, stderr: "nrfutil: only dfu genpkg is implemented, got " + words[0], stdout: "", files: [] };
  const values = new Map();
  const positional = [];
  for (let index = 0; index < words.length; index += 1) {
    const arg = words[index];
    if (arg === "--application" || arg === "--dev-type" || arg === "--sd-req" || arg === "--dev-rev"
      || arg === "--application-version") {
      const value = words[index + 1];
      if (value === undefined) return { code: 1, stderr: "nrfutil: " + arg + " needs a value", stdout: "", files: [] };
      // --sd-req is a scalar option in the real tool: the last one wins rather
      // than accumulating, which the reference run with two of them showed.
      values.set(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return { code: 1, stderr: "nrfutil: " + arg + " is not part of genpkg as implemented here", stdout: "", files: [] };
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return {
      code: 1,
      stderr: "nrfutil: genpkg takes one output package, got " + positional.length,
      stdout: "",
      files: [],
    };
  }
  const input = values.get("--application");
  const output = positional[0];
  if (!input) return { code: 1, stderr: "nrfutil: genpkg needs --application", stdout: "", files: [] };
  const text = await readFile(input);
  if (!text) return { code: 1, stderr: "nrfutil: cannot read " + input, stdout: "", files: [] };
  const source = typeof text === "string" ? text : new TextDecoder().decode(text);
  let bin;
  try {
    bin = toBin(parseHex(source));
  } catch (error) {
    return { code: 1, stderr: "nrfutil: " + error.message, stdout: "", files: [] };
  }
  const deviceType = values.has("--dev-type") ? parseNumber(values.get("--dev-type")) : 0x0052;
  const deviceRevision = values.has("--dev-rev") ? parseNumber(values.get("--dev-rev")) : DEVICE_REVISION_DEFAULT;
  const appVersion = values.has("--application-version")
    ? parseNumber(values.get("--application-version"))
    : APP_VERSION_DEFAULT;
  const softdeviceReq = values.has("--sd-req") ? [parseNumber(values.get("--sd-req"))] : [];
  const firmwareCrc16 = crc16(bin);
  const dat = initPacket({ deviceType, deviceRevision, appVersion, softdeviceReq, firmwareCrc16 });
  // The entries are named after the .hex that was packaged, not after the
  // package: nrfutil reads the application filename from --application.
  const base = input.replace(/^.*\//, "").replace(/\.hex$/, "");
  const manifest = jsonText({
    manifest: {
      application: {
        bin_file: base + ".bin",
        dat_file: base + ".dat",
        init_packet_data: {
          application_version: appVersion,
          device_revision: deviceRevision,
          device_type: deviceType,
          firmware_crc16: firmwareCrc16,
          softdevice_req: softdeviceReq,
        },
      },
      dfu_version: 0.5,
    },
  });
  const packageBytes = zip([
    { name: base + ".bin", data: bin },
    { name: base + ".dat", data: dat },
    { name: "manifest.json", data: new TextEncoder().encode(manifest) },
  ]);
  return { code: 0, stdout: "", stderr: "", files: [{ path: output, data: packageBytes }] };
}
