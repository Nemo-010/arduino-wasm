// The DFU packaging step is a Python tool in the real toolchain, so the page
// carries a port of it. A port is only worth having if its output is the same
// bytes, so this compares against a package the real adafruit-nrfutil made:
// test/fixtures/nrfutil/ was produced with
//
//   adafruit-nrfutil 0.5.3.post16
//   adafruit-nrfutil dfu genpkg --dev-type 0x0052 --sd-req 0x0123 \
//     --sd-req 0x00B6 --application gap.hex gap.zip
//
// gap.hex is not a trivial file on purpose: two segments with a hole between
// them, and a total length that is not a multiple of four, so the gap fill and
// the word rounding are both exercised.
//
// Set NRFUTIL_BIN to the real executable to re-run it and compare live rather
// than against the stored bytes.

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { unzip } from "./zip.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { genpkg, crc16, parseHex } from "../web/nrfutil.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures/nrfutil");

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log("ok " + name);
    return;
  }
  failures += 1;
  console.log("FAIL " + name + (detail === undefined ? "" : " — " + detail));
}

function sameBytes(left, right) {
  return left.length === right.length && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

const hexBytes = await readFile(path.join(fixtures, "gap.hex"));
const readHex = (path_) => (path_ === "/work/gap.hex" ? hexBytes : null);
const argv = ["dfu", "genpkg", "--dev-type", "0x0052", "--sd-req", "0x0123", "--sd-req", "0x00B6",
  "--application", "/work/gap.hex", "/work/gap.zip"];

const result = await genpkg(argv, { readFile: readHex });
check("genpkg exits 0", result.code === 0, result.stderr);
check("genpkg writes one file", result.files.length === 1, JSON.stringify(result.files.map((file) => file.path)));
if (result.code !== 0) {
  console.log(failures + " of " + checks + " checks failed");
  process.exit(1);
}

const entries = unzip(result.files[0].data);
check("the package has three entries", entries.size === 3, [...entries.keys()].join(", "));
check("every entry is stored, not deflated",
  [...entries.values()].every((entry) => entry.method === 0),
  [...entries.values()].map((entry) => entry.method).join(", "));

const goldens = {
  "gap.bin": await readFile(path.join(fixtures, "gap.bin")),
  "gap.dat": await readFile(path.join(fixtures, "gap.dat")),
  "manifest.json": await readFile(path.join(fixtures, "manifest.json")),
};
for (const [name, golden] of Object.entries(goldens)) {
  const entry = entries.get(name);
  check(name + " is in the package", entry !== undefined);
  if (entry === undefined) continue;
  check(name + " is byte-identical to the real tool's output", sameBytes(entry.data, golden),
    "got " + entry.data.length + " bytes, expected " + golden.length);
}

// The .dat carries the CRC of the .bin twice over: as its last field, and as a
// number in the manifest. Reading both from the golden files and demanding that
// they agree is a check that does not depend on this port at all.
const manifest = JSON.parse(new TextDecoder().decode(goldens["manifest.json"]));
const bin = goldens["gap.bin"];
const dat = goldens["gap.dat"];
check("the golden .dat ends with the CRC of the golden .bin",
  ((dat[dat.length - 1] << 8) | dat[dat.length - 2]) === crc16(bin),
  "dat tail " + dat[dat.length - 1].toString(16) + dat[dat.length - 2].toString(16) + ", crc16 " + crc16(bin).toString(16));
check("the golden manifest agrees with that CRC",
  manifest.manifest.application.init_packet_data.firmware_crc16 === crc16(bin));
check("the golden .bin is the two segments with the hole filled with 0xFF and the length rounded up to four",
  bin.length === 8196 && bin[12] === 0x0d && bin[13] === 0xff && bin[8194] === 0xcc && bin[8195] === 0xff,
  "length " + bin.length);

// A checksum that does not add up must be refused, not carried into a package
// the bootloader would reject.
const broken = Buffer.from(hexBytes);
broken[9] = broken[9] === 0x41 ? 0x42 : 0x41;
let refused = false;
try {
  parseHex(new TextDecoder().decode(broken));
} catch (error) {
  refused = /checksum/.test(error.message);
}
check("a hex record with a bad checksum is refused", refused);

// A subcommand this port does not implement must be named, not ignored.
const other = await genpkg(["dfu", "serial", "-pkg", "x.zip"], { readFile: readHex });
check("an unimplemented subcommand is refused by name",
  other.code === 1 && /only dfu genpkg/.test(other.stderr), other.stderr);

if (process.env.NRFUTIL_BIN) {
  const dir = path.join(process.env.TMPDIR || "/tmp", "nrfutil-live");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const work = await mkdtemp(dir + "-");
  await writeFile(path.join(work, "gap.hex"), hexBytes);
  execFileSync(process.env.NRFUTIL_BIN,
    ["dfu", "genpkg", "--dev-type", "0x0052", "--sd-req", "0x0123", "--sd-req", "0x00B6",
      "--application", path.join(work, "gap.hex"), path.join(work, "live.zip")],
    { stdio: "pipe" });
  const live = unzip(new Uint8Array(await readFile(path.join(work, "live.zip"))));
  for (const name of Object.keys(goldens)) {
    check(name + " matches a live run of " + path.basename(process.env.NRFUTIL_BIN),
      sameBytes(live.get(name).data, goldens[name]));
  }
} else {
  console.log("skip live comparison: set NRFUTIL_BIN to the real adafruit-nrfutil to re-run it");
}

console.log(failures === 0 ? "all checks passed" : failures + " of " + checks + " checks failed");
process.exit(failures === 0 ? 0 : 1);
