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
  realProcess.exit(0);
} catch (error) {
  console.log("  compile failed: " + error.message);
  const spawned = /not implemented on js|fork\/exec|exec:/.test(error.message);
  check(spawned, "the failure is the toolchain spawn, not something earlier");
  realProcess.exit(spawned ? 3 : 1);
}
