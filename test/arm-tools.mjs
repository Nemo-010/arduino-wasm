// The ARM binutils as WebAssembly: do gas, ld, objcopy and ar produce what a
// Cortex-M needs?
//
// These are built by scripts/build-arm-tools.py from GNU binutils 2.42 with
// Emscripten, the same recipe the AVR toolchain comes from. Nothing here
// involves arduino-cli; this test asks only whether the tools themselves work,
// because a compiler for nRF52 depends on that and nothing else can be built
// until it is true.
//
// The assertion is on the bytes: the linked image is disassembled by hand as
// Thumb encodings, and the archive is fed back to ld to show that what ar
// wrote is what ld reads.
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 a prerequisite is absent.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createArmTools } from "../web/arm-tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const OUT = path.join(ROOT, "build/arm-wasm/out");
const NAMES = ["as", "ld", "objcopy", "ar"];

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log((ok ? "ok   " : "FAIL ") + name + (detail ? " [" + detail + "]" : ""));
}

const missing = [];
for (const name of NAMES) {
  for (const suffix of [".mjs", ".wasm"]) {
    try {
      await stat(path.join(OUT, name + suffix));
    } catch {
      missing.push(name + suffix);
    }
  }
}
if (missing.length) {
  console.log("skipped: missing " + missing.join(", "));
  console.log("build them with: python3 scripts/build-arm-tools.py   (needs EMSDK=... with 4.0.10)");
  process.exit(2);
}

const tools = createArmTools({
  importModule: (name) => import(pathToFileURL(path.join(OUT, name + ".mjs")).href),
  readWasm: (name) => readFile(path.join(OUT, name)),
  note: (line) => console.log("note " + line),
});

const encoder = new TextEncoder();

// A Cortex-M4 vector table entry point: the instruction encodings below are the
// ones this source must produce, checked against the linked binary.
const SOURCE = `.syntax unified
.thumb
.cpu cortex-m4
.section .text.startup, "ax"
.global Reset_Handler
.thumb_func
.type Reset_Handler, %function
Reset_Handler:
  ldr r0, =0x20001000
  movs r1, #1
  str r1, [r0]
  b .
.size Reset_Handler, . - Reset_Handler
`;

const SCRIPT = `ENTRY(Reset_Handler)
MEMORY
{
  FLASH (rx)  : ORIGIN = 0x00000000, LENGTH = 1024K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 256K
}
SECTIONS
{
  .text : { KEEP(*(.text.startup)) *(.text*) *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM
  .bss  : { *(.bss*) *(COMMON) } > RAM
}
`;

// 01 48 = ldr r0, [pc, #4]; 01 21 = movs r1, #1; 01 60 = str r1, [r0];
// FE E7 = b . ; 00 10 00 20 = the literal 0x20001000, little endian.
const EXPECTED = [0x01, 0x48, 0x01, 0x21, 0x01, 0x60, 0xfe, 0xe7];

function elfHeader(data) {
  if (data.length < 52) return null;
  const magic = Buffer.from(data.slice(0, 4)).toString("latin1");
  return {
    magic,
    class: data[4],
    endian: data[5],
    type: data[16] | (data[17] << 8),
    machine: data[18] | (data[19] << 8),
    entry: Buffer.from(data.slice(24, 28)).readUInt32LE(0),
  };
}

function hexToBytes(data) {
  const lines = new TextDecoder().decode(data).split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
  const bytes = [];
  let sawEOF = false;
  for (const line of lines) {
    if (!line.startsWith(":")) return { bytes, sawEOF, bad: line };
    const record = Buffer.from(line.slice(1), "hex");
    const length = record[0];
    const type = record[3];
    if (type === 0) for (let i = 0; i < length; i++) bytes.push(record[4 + i]);
    if (type === 1) sawEOF = true;
    // Intel HEX checksum: every byte of the record, the checksum included,
    // sums to zero mod 256.
    const sum = record.reduce((a, b) => a + b, 0);
    if ((sum & 0xff) !== 0) return { bytes, sawEOF, bad: line };
  }
  return { bytes, sawEOF, bad: null };
}

const files = [
  { path: "/work/blink.s", data: encoder.encode(SOURCE) },
  { path: "/work/link.ld", data: encoder.encode(SCRIPT) },
];

const as = await tools.run("as", ["-mcpu=cortex-m4", "-mthumb", "-o", "/work/blink.o", "/work/blink.s"], {
  files,
  outputs: ["/work/blink.o"],
});
const object = as.files[0] && as.files[0].data;
check("gas assembles a Thumb object", as.code === 0 && !!object, "exit " + as.code + (object ? ", " + object.length + " bytes" : "") + (as.stderr ? " " + as.stderr.trim().slice(0, 300) : ""));
const objectHeader = object && elfHeader(object);
check("the object is ELF32 for ARM (machine 40)", !!objectHeader && objectHeader.magic === "\x7fELF" && objectHeader.machine === 40 && objectHeader.type === 1, objectHeader ? "machine " + objectHeader.machine + ", type " + objectHeader.type : "unparsed");
console.log(as.stderr.trim().split("\n").filter((line) => /error|warning/.test(line)).slice(0, 5).map((line) => "as: " + line).join("\n") || "as: no diagnostics");

const ld = await tools.run("ld", ["-T", "/work/link.ld", "-o", "/work/blink.elf", "/work/blink.o"], {
  files: [...files, { path: "/work/blink.o", data: object }],
  outputs: ["/work/blink.elf"],
});
const elf = ld.files[0] && ld.files[0].data;
const header = elf && elfHeader(elf);
check("ld links an executable for ARM", ld.code === 0 && !!header && header.machine === 40 && header.type === 2, header ? "machine " + header.machine + ", type " + header.type + ", " + elf.length + " bytes" : "no elf, exit " + ld.code);
// A Thumb entry address carries bit 0 set; that bit is not part of the address.
check("the entry point is Thumb", !!header && (header.entry & 1) === 1, header ? "entry 0x" + header.entry.toString(16) : "no elf");

// objcopy -O binary is the shortest route from the linked ELF to the bytes the
// flash would hold, so the encodings can be compared without a disassembler.
const binary = await tools.run("objcopy", ["-O", "binary", "/work/blink.elf", "/work/blink.bin"], {
  files: [{ path: "/work/blink.elf", data: elf }],
  outputs: ["/work/blink.bin"],
});
const image = binary.files[0] && binary.files[0].data;
const firstBytes = image ? Array.from(image.slice(0, EXPECTED.length)) : [];
check(
  "the linked image holds the Thumb encodings of the source",
  binary.code === 0 && firstBytes.every((byte, index) => byte === EXPECTED[index]),
  "got " + firstBytes.map((b) => b.toString(16).padStart(2, "0")).join(" ") + ", want " + EXPECTED.map((b) => b.toString(16).padStart(2, "0")).join(" ")
);
const literal = image ? Array.from(image.slice(EXPECTED.length, EXPECTED.length + 4)) : [];
check("the literal pool holds 0x20001000", literal.join(",") === "0,16,0,32", "got " + literal.map((b) => b.toString(16).padStart(2, "0")).join(" "));

const ihex = await tools.run("objcopy", ["-O", "ihex", "/work/blink.elf", "/work/blink.hex"], {
  files: [{ path: "/work/blink.elf", data: elf }],
  outputs: ["/work/blink.hex"],
});
const hex = ihex.files[0] && hexToBytes(ihex.files[0].data);
check("objcopy writes Intel HEX that parses and ends at EOF", ihex.code === 0 && !!hex && hex.sawEOF && hex.bad === null, hex ? (hex.bad ? "bad record " + JSON.stringify(hex.bad) : hex.bytes.length + " data bytes, EOF record present") : "no output");
check("the hex payload is the same image", !!hex && hex.bytes.length >= EXPECTED.length && EXPECTED.every((byte, index) => hex.bytes[index] === byte), hex ? hex.bytes.slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join(" ") : "no hex");

// ar has to write an archive ld can consume, index included; linking from the
// archive rather than the object is what proves it.
const ar = await tools.run("ar", ["rcs", "/work/libblink.a", "/work/blink.o"], {
  files: [{ path: "/work/blink.o", data: object }],
  outputs: ["/work/libblink.a"],
});
const archive = ar.files[0] && ar.files[0].data;
check("ar writes a GNU archive", ar.code === 0 && !!archive && Buffer.from(archive.slice(0, 8)).toString("latin1") === "!<arch>\n", archive ? archive.length + " bytes" : "no output, exit " + ar.code);

const ldFromArchive = await tools.run("ld", ["-T", "/work/link.ld", "-o", "/work/fromarchive.elf", "/work/libblink.a"], {
  files: [...files, { path: "/work/libblink.a", data: archive }],
  outputs: ["/work/fromarchive.elf"],
});
const linkedFromArchive = ldFromArchive.files[0] && ldFromArchive.files[0].data;
const fromArchive = await tools.run("objcopy", ["-O", "binary", "/work/fromarchive.elf", "/work/fromarchive.bin"], {
  files: [{ path: "/work/fromarchive.elf", data: linkedFromArchive }],
  outputs: ["/work/fromarchive.bin"],
});
const archiveImage = fromArchive.files[0] && fromArchive.files[0].data;
check(
  "ld links from the archive ar wrote, giving the same image",
  ldFromArchive.code === 0 && !!archiveImage && archiveImage.length === (image ? image.length : -1) &&
    Array.from(archiveImage).every((byte, index) => byte === image[index]),
  archiveImage ? archiveImage.length + " bytes" : "no output, exit " + ldFromArchive.code
);

// A failing tool has to fail visibly: the harness must not turn a non-zero exit
// into a quiet zero, or every check above would pass on a tool that did nothing.
const bad = await tools.run("as", ["-mcpu=cortex-m99", "-mthumb", "-o", "/work/bad.o", "/work/blink.s"], {
  files,
  // No declared output: this run is expected to write nothing, and a note
  // about that would be noise beside the check it is part of.
  outputs: [],
});
check("a bad -mcpu makes as exit non-zero", bad.code !== 0, "exit " + bad.code + (bad.stderr ? ": " + bad.stderr.trim().split("\n")[0].slice(0, 120) : ""));

const failed = checks.filter((entry) => !entry.ok);
console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " checks passed");
process.exit(failed.length ? 1 : 0);
