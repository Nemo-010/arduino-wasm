// Opt-in: install the Seeed nRF52 core through the wasm CLI and try to compile
// blink for the XIAO nRF52840, which is the board this project is aimed at.
//
//   NETWORK=1 node test/nrf52.mjs
//
// Exit codes, so the outcome is machine-readable rather than prose:
//   0  the compile succeeded
//   2  a download was refused (the sandbox cannot reach the file)
//   3  the compile reached the toolchain and could not start it
//   1  something else broke
//
// Downloads are real: the index is 290 KB over TLS and the platform install
// pulls the core plus its tool dependencies (hundreds of megabytes).

import { startCLI } from "./harness.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installArmExec } from "../web/arm-exec.js";
import { createArmAssets } from "../web/arm-assets.js";

import { unzip } from "./zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARM_TOOLS = path.join(here, "../web/tools/arm");

const realProcess = process;

if (realProcess.env.NETWORK !== "1") {
  console.log("skipped: set NETWORK=1 to run");
  realProcess.exit(0);
}

const INDEX_URL = "https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json";
const PACKAGE = "Seeeduino";
const ARCH = "nrf52";
const PLATFORM_VERSION = "1.1.9";
const FQBN = "Seeeduino:nrf52:xiaonRF52840";
const SKETCH_DIR = "/home/arduino/Blink";
const SKETCH = `${SKETCH_DIR}/Blink.ino`;

const BLINK = `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

const cli = await startCLI({ env: { ARDUINO_DEFAULT_INDEX_URL: INDEX_URL } });
const fs = cli.shim.fs;

const promisify = (fn, ...args) =>
  new Promise((resolve, reject) =>
    fn(...args, (error, value) => (error ? reject(error) : resolve(value))));

async function writeFile(file, text) {
  const pending = promisify(fs.open, file, "w", 0o644);
  const fd = await pending;
  const bytes = new TextEncoder().encode(text);
  await promisify(fs.write, fd, bytes, 0, bytes.length, 0);
  await promisify(fs.close, fd);
}

await cli.call("ConfigurationOpen", {
  encoded_settings: [
    "directories:",
    "  data: /home/arduino/.arduino15",
    "  downloads: /home/arduino/.arduino15/staging",
    "  user: /home/arduino/Arduino",
    "",
  ].join("\n"),
  settings_format: "yaml",
});

const created = await cli.call("Create", {});
const instance = created[0].data.instance;
console.log(`  instance ${instance.id}`);

// The libraries index lives on a host this sandbox cannot reach; the CLI
// fetches it first during Init and returns that error, which is not what this
// script is about.
await cli.call("Init", { instance }).catch((error) => console.log("  init: " + error.message));

console.log(`\nAdd the board URL and fetch it: ${INDEX_URL}`);
const update = await cli.call("UpdateIndex", {
  instance,
  update_if_older_than_secs: 0,
}, { timeoutMs: 300000 });
const reports = update.flatMap((event) => event.data?.updatedIndexes ?? []);
console.log("  " + JSON.stringify(reports));
check(reports.some((report) => report.status === "STATUS_UPDATED"), "index downloaded over TLS");

await cli.call("Init", { instance }).catch((error) => console.log("  init: " + error.message));

console.log(`\nSearch the index for ${PACKAGE}:${ARCH}`);
const search = await cli.call("PlatformSearch", { instance, search_args: ARCH });
const platforms = search.flatMap((event) => event.data?.searchOutput ?? []);
const found = platforms.find((entry) => entry.metadata?.id === `${PACKAGE}:${ARCH}`);
console.log(`  ${platforms.length} platforms, ${Object.keys(found?.releases ?? {}).length} releases`);
check(Boolean(found), `${PACKAGE}:${ARCH} is known to the CLI`);

const release = found?.releases?.[PLATFORM_VERSION];
const board = (release?.boards ?? []).find((entry) => entry.name?.includes("XIAO nRF52840"));
console.log(`  ${PLATFORM_VERSION} carries ${(release?.boards ?? []).length} boards, e.g. ${board?.name ?? "none"}`);
check(Boolean(board), "the release lists the XIAO nRF52840");

console.log(`\nInstall ${PACKAGE}:${ARCH}@${PLATFORM_VERSION} (core plus tool dependencies)`);
let installError = null;
try {
  await cli.call("PlatformInstall", {
    instance,
    platform_package: PACKAGE,
    architecture: ARCH,
    version: PLATFORM_VERSION,
    skip_post_install: true,
  }, {
    timeoutMs: 3600000,
    onEvent: (event) => {
      if (event.type === "progress" || event.type === "task") {
        const text = event.data?.message ?? event.data?.name ?? "";
        // globalThis.process belongs to the shim here, so use the real one.
        if (text) realProcess.stderr.write(`  ${text}\n`);
      }
    },
  });
} catch (error) {
  installError = error;
  console.log("  install failed: " + error.message);
}

const keys = await cli.shim.backend.keys();
const installed = keys.filter((key) => key.toLowerCase().includes("/packages/seeeduino/hardware/nrf52/"));
const toolFiles = keys.filter((key) => key.toLowerCase().includes("/packages/seeeduino/tools/"));
console.log(`  files on disk: ${installed.length} core, ${toolFiles.length} tool`);
if (!installError) {
  check(installed.length > 0, "the core landed in the data dir");
  // The toolchain is a vendor blob with no source, so it can never run as wasm.
  // Recording what it actually is keeps the gex option honest: gex runs Linux
  // ELF, and only an x86-64 or aarch64 binary would run under it.
  const gccPath = toolFiles.find((key) => /arm-none-eabi-gcc\/9-2019q4\/bin\/arm-none-eabi-g\+\+$/i.test(key));
  check(Boolean(gccPath), "the ARM toolchain binary is in the filesystem");
  if (gccPath) {
    const { data } = await cli.shim.backend.get(gccPath);
    const magic = data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46;
    const machine = data[18] | (data[19] << 8);
    console.log(`  ${gccPath} ${data.length} bytes`);
    check(magic, "the toolchain is an ELF binary");
    check(machine === 0x3e, `the toolchain is x86-64 (e_machine ${machine})`);
  }
}

console.log(`\nWrite blink to ${SKETCH}`);
await promisify(fs.mkdir, SKETCH_DIR, 0o755).catch((error) => {
  if (error.code !== "EEXIST") console.log("  mkdir: " + error.message);
});
await writeFile(SKETCH, BLINK);
const written = await cli.shim.backend.get(SKETCH);
check(written?.data?.length === BLINK.length, "sketch written into the wasm filesystem");

if (installError) {
  const refused = /403|404|Forbidden|Access Denied|download|downloads\.arduino\.cc/i.test(installError.message);
  console.log(`\nThe compile cannot run without an installed core. ${refused ? "The download was refused." : ""}`);
  realProcess.exit(refused ? 2 : 1);
}

console.log(`\nCompile blink for ${FQBN}`);

// Answer the toolchain's command lines from the wasm tools built by
// scripts/build-arm-tools.py. Without this the CLI reaches its "pipe: not
// implemented on js" wall, which is what this test used to prove.
const armNotes = [];
const armAssets = createArmAssets({
  load: (name) => readFile(path.join(ARM_TOOLS, name)),
  importModule: (name) => import(pathToFileURL(path.join(ARM_TOOLS, name + ".mjs")).href),
});
installArmExec({
  nodefs: cli.shim,
  readAsset: armAssets.readAsset,
  importModule: armAssets.importModule,
  log: (line) => {
    armNotes.push(line);
    if (/ignores|no implementation|cannot|missing/i.test(line)) realProcess.stderr.write("  " + line + "\n");
  },
});

// ARM_TRACE=1 prints every command line the CLI asks for and the code the
// driver answered with. A compile that stops mid-recipe is invisible otherwise.
if (realProcess.env.ARM_TRACE === "1") {
  const inner = globalThis.arduinoExec;
  let index = 0;
  globalThis.arduinoExec = (request, callback) => {
    index += 1;
    const args = request.args ?? [];
    const tool = String(args[0] ?? "").split("/").pop();
    const shown = args.slice(1).filter((arg) => /^-o$|^-c$|^-E$|^-MMD$|^--specs=|^-mcpu=|^-[TWLl]$/.test(arg) || /\.[ch]$|\.cpp$|\.o$|\.elf$|\.hex$|\.a$/.test(arg));
    realProcess.stderr.write(`  exec ${index}: ${tool} ${shown.join(" ")}\n`);
    inner(request, (result) => {
      realProcess.stderr.write(`  exec ${index}: exit ${result.code}${result.stderr ? " stderr=" + String(result.stderr).slice(0, result.code === 0 ? 160 : 2000) : ""}${result.error ? " error=" + String(result.error).slice(0, 300) : ""}${result.code !== 0 ? "\n    argv: " + args.join(" ") : ""}\n`);
      callback(result);
    });
  };
}

try {
  const result = await cli.call("Compile", {
    instance,
    fqbn: FQBN,
    sketch_path: SKETCH_DIR,
    verbose: true,
  }, { timeoutMs: 3600000 });
  const output = result
    .map((event) => event.data?.outStream ?? event.data?.errStream ?? "")
    .map((encoded) => Buffer.from(encoded, "base64").toString())
    .join("");
  console.log("  compile succeeded");
  if (output) console.log(output.split("\n").slice(-10).join("\n"));

  // The artefact, not the exit code: a compile that reported success and wrote
  // no image would pass on the message alone.
  const keysAtEnd = await cli.shim.backend.keys();
  const elfKey = keysAtEnd.find((key) => /\/Blink\.ino\.elf$/i.test(key));
  const hexKey = keysAtEnd.find((key) => /\/Blink\.ino\.hex$/i.test(key));
  check(Boolean(elfKey), "the link wrote an ELF");
  check(Boolean(hexKey), "objcopy wrote an Intel HEX");
  if (elfKey) {
    const { data } = await cli.shim.backend.get(elfKey);
    const magic = data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46;
    const machine = data[18] | (data[19] << 8);
    console.log(`  ${elfKey} ${data.length} bytes`);
    check(magic, "the image is an ELF");
    check(machine === 40, `the image is ARM (e_machine ${machine})`);
  }
  // NRF52_DUMP=<dir> writes the build's own artefacts out, so a run can be
  // inspected without instrumenting the shim.
  if (realProcess.env.NRF52_DUMP) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(realProcess.env.NRF52_DUMP, { recursive: true });
    for (const key of keysAtEnd) {
      // Only this sketch's build directory: the installed platform ships dozens
      // of archives, and dumping them says nothing about the compile.
      if (!key.startsWith("/home/arduino/.cache/arduino/sketches/")) continue;
      if (!/\.(elf|hex|zip|map|bin|dat)$/.test(key)) continue;
      const { data } = await cli.shim.backend.get(key);
      await writeFile(key.replace(/^.*\//, "").replace(/^/, realProcess.env.NRF52_DUMP + "/"), data);
      console.log(`  dumped ${key}`);
    }
  }
  if (hexKey) {
    const { data } = await cli.shim.backend.get(hexKey);
    const text = new TextDecoder().decode(data);
    const lines = text.split(/\r?\n/).filter(Boolean);
    console.log(`  ${hexKey} ${data.length} bytes, ${lines.length} records`);
    check(lines.length > 1, "the HEX has records");
    check(lines[lines.length - 1].trim() === ":00000001FF", "the HEX ends with an EOF record");
    // The vector table is not the first record: objcopy writes the initialised
    // .data at its RAM address first, with an extended-address record. So the
    // table is located from the ELF's entry point, which is the reset handler
    // it names, and the four bytes before that are the initial stack pointer.
    // An XIAO nRF52840 has 256 KiB of RAM, so a stack pointer in the top page
    // is the only one that bootloader and sketch agree on.
    const words = [];
    let base = 0;
    for (const line of lines) {
      const record = line.replace(/^:/, "");
      const count = parseInt(record.slice(0, 2), 16);
      const type = parseInt(record.slice(6, 8), 16);
      const payload = record.slice(8, 8 + count * 2);
      if (type === 0) {
        for (let index = 0; index < count; index += 1) {
          words.push({ address: base + parseInt(record.slice(2, 6), 16) + index,
            value: parseInt(payload.slice(index * 2, index * 2 + 2), 16) });
        }
      } else if (type === 2 || type === 4) {
        base = parseInt(payload, 16) * (type === 2 ? 16 : 65536);
      }
    }
    const elf = elfKey ? (await cli.shim.backend.get(elfKey)).data : null;
    const entry = elf ? (elf[24] | (elf[25] << 8) | (elf[26] << 16) | (elf[27] << 24)) : 0;
    check((entry & 1) === 1, `the ELF entry point is a Thumb address (0x${entry.toString(16)})`);
    const at = words.findIndex((word, index) => word.value === (entry & 0xff)
      && words[index + 1] && words[index + 1].value === ((entry >>> 8) & 0xff)
      && words[index + 2] && words[index + 2].value === ((entry >>> 16) & 0xff)
      && words[index + 3] && words[index + 3].value === ((entry >>> 24) & 0xff));
    let sp = 0;
    if (at >= 4) {
      sp = words[at - 4].value | (words[at - 3].value << 8) | (words[at - 2].value << 16) | (words[at - 1].value << 24);
    }
    check(at >= 4, `the reset handler appears in the image (at word ${at})`);
    check(sp >= 0x20000000 && sp <= 0x20040000 && sp % 8 === 0,
      `the word before the reset handler is a RAM stack pointer (0x${sp.toString(16)})`);
  }

  // The DFU package, and the same package from the real tool when it is
  // installed. Both are the same input .hex, so the entries must be identical:
  // the port's own output agreeing with itself would prove nothing.
  const zipKey = keysAtEnd.find((key) => /\/Blink\.ino\.zip$/i.test(key));
  check(Boolean(zipKey), "the recipe wrote a DFU package");
  if (zipKey && hexKey) {
    const zip = (await cli.shim.backend.get(zipKey)).data;
    const entries = unzip(zip);
    console.log(`  ${zipKey} ${zip.length} bytes, entries ${[...entries.keys()].join(", ")}`);
    const manifest = entries.get("manifest.json");
    check(Boolean(manifest), "the package holds a manifest");
    if (manifest) {
      const parsed = JSON.parse(new TextDecoder().decode(manifest.data));
      // From the platform's boards.txt: xiaonRF52840.menu.softdevice.s140v6
      // .build.sd_fwid=0x0123, which is the softdevice this board's package
      // has to be addressed to.
      // manifest.json nests these under manifest.application.init_packet_data.
      const packet = parsed.manifest.application.init_packet_data;
      check(JSON.stringify(packet.softdevice_req) === "[291]",
        `the manifest requires softdevice 0x0123 (${JSON.stringify(packet.softdevice_req)})`);
      check(parsed.manifest.application.dat_file === "Blink.ino.dat"
        && parsed.manifest.application.bin_file === "Blink.ino.bin",
        "the manifest names this sketch's files");
    }

    const oracle = realProcess.env.NRFUTIL_BIN;
    if (oracle) {
      const { mkdtemp, writeFile, readFile: read } = await import("node:fs/promises");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const dir = await mkdtemp("/tmp/nrf52-oracle-");
      const hexText = new TextDecoder().decode((await cli.shim.backend.get(hexKey)).data)
        .replace(/\r\n/g, "\n");
      const hexPath = path.join(dir, "Blink.ino.hex");
      const outPath = path.join(dir, "Blink.ino.zip");
      await writeFile(hexPath, hexText);
      await promisify(execFile)(oracle, ["dfu", "genpkg", "--dev-type", "0x0052",
        "--sd-req", "0x0123", "--application", hexPath, outPath]);
      const theirs = unzip(await read(outPath));
      check([...theirs.keys()].sort().join(",") === [...entries.keys()].sort().join(","),
        `the package holds the same entry names as adafruit-nrfutil (${[...theirs.keys()].join(", ")})`);
      for (const [name, entry] of theirs) {
        const mine = entries.get(name);
        const same = mine !== undefined && mine.data.length === entry.data.length
          && Buffer.compare(Buffer.from(mine.data), Buffer.from(entry.data)) === 0;
        check(same, `${name} is byte-identical to adafruit-nrfutil's (${entry.data.length} bytes)`);
      }
    } else {
      console.log("  skipped: set NRFUTIL_BIN to compare the package with adafruit-nrfutil");
    }
  }
  realProcess.exit(failures ? 1 : 0);
} catch (error) {
  console.log("  compile failed: " + error.message);
  // Before the ARM driver existed this failure was always the spawn wall. Now a
  // failure is a failure, unless the seam itself reported no implementation.
  const unimplemented = /not implemented on js|fork\/exec|exec:/.test(error.message);
  if (unimplemented) {
    check(false, "the toolchain spawn is still unimplemented");
    realProcess.exit(3);
  }
  const lastNotes = armNotes.slice(-8);
  if (lastNotes.length) {
    realProcess.stderr.write("\n  driver notes:\n");
    for (const line of lastNotes) realProcess.stderr.write("    " + line + "\n");
  }
  realProcess.exit(1);
}
