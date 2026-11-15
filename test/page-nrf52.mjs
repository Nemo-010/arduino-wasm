// The page's nRF52 path, end to end: the shipped Seeeduino index, the shipped
// wasm ARM toolchain, the page's own index shim, its own asset loader, its own
// exec seam — routing a command line to the ARM driver rather than the AVR one —
// and its own buttons.
//
// The DOM and the browser are fake (test/dom.mjs); the CLI, the compiler, the
// driver, the DFU packer and the filesystem are the real ones. Nothing here
// reaches a socket: every URL in the shipped index points at a synthetic origin
// that the page maps onto its own directory.
//
// Run with: node test/page-nrf52.mjs

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildDocument,
  check,
  installBrowserGlobals,
  installXhr,
  waitFor,
  web,
  WEB_INDEX_URL,
} from "./dom.mjs";

const realProcess = process;
const verbose = realProcess.env.VERBOSE === "1";

const ORIGIN = "https://arduino-wasm.invalid";
const NRF52_INDEX_URL = ORIGIN + "/indexes/nrf52/nrf52_index.json";
const FQBN = "Seeeduino:nrf52:xiaonRF52840";
const SKETCHES = "/home/arduino/.cache/arduino/sketches";

const REQUIRED = [
  "arduino-cli.wasm",
  "indexes/nrf52/nrf52_index.json",
  "indexes/nrf52/Seeed_nRF52_Boards-1.1.9.tar.bz2",
  "indexes/nrf52/tools/arm-none-eabi-gcc-9-2019q4.tar.gz",
  "indexes/nrf52/tools/nrfjprog-9.4.0.tar.gz",
  "indexes/nrf52/tools/CMSIS-5.7.0.tar.gz",
  "tools/arm/cc1plus.wasm.gz",
  "tools/arm/sysroot.tar.gz",
];

async function main() {
  const missing = [];
  for (const name of REQUIRED) {
    try {
      await readFile(path.join(web, name));
    } catch (error) {
      missing.push(name);
    }
  }
  if (missing.length) {
    console.log("skipping: the page's nRF52 assets are not here: " + missing.join(", "));
    console.log(
      "  build them with: python3 scripts/update.py && python3 scripts/build-arm-tools.py" +
        " && python3 scripts/make-arm-assets.py && python3 scripts/make-nrf52-index.py" +
        " --out web/indexes/nrf52 --base-url " + ORIGIN + "/indexes/nrf52/",
    );
    realProcess.exit(2);
  }

  const { document, byId } = await buildDocument({ baseURI: WEB_INDEX_URL });
  installBrowserGlobals({
    document,
    config: {
      // Empty means "the indexes this page ships", which is the point of the test.
      "arduino.index.default": "",
      "arduino.index.extra": "",
      "arduino.index.library": "",
    },
  });
  installXhr({ root: web });

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://page.test/");
    const name = url.pathname.replace(/^\//, "");
    if (name === "version.json" || name === "arduino-cli.wasm") {
      const body = await readFile(path.join(web, name));
      return new Response(body, {
        headers: { "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/json" },
      });
    }
    throw new Error("this test only serves the page's own files, and the page asked for " + url.href);
  };

  // Capture what the page hands to its two download links.
  const downloads = new Map();
  URL.createObjectURL = (blob) => {
    const key = "blob:" + (downloads.size + 1);
    downloads.set(key, blob);
    return key;
  };

  createRequire(import.meta.url)(path.join(web, "wasm_exec.js"));

  const log = () => byId.get("log").textContent;
  const status = () => byId.get("status").textContent;

  console.log("\nBoot");
  await import(pathToFileURL(path.join(web, "app.js")).href);
  try {
    await waitFor(
      () => status().includes("ready") || log().includes("failed to start"),
      "boot",
      60000,
    );
  } catch (error) {
    console.log("  status: " + status());
    console.log(log());
    throw error;
  }
  check(!log().includes("failed to start"), "the page booted without an error");
  check(status().includes("ready"), "the CLI is ready");
  check(
    byId.get("index-extra").value === NRF52_INDEX_URL,
    "the shipped nRF52 index is registered: " + byId.get("index-extra").value,
  );

  console.log("\nInstall " + FQBN.split(":").slice(0, 2).join(":") + " from the shipped index");
  // No press of "Update indexes": a first visit has no indexes, and installing a
  // core is the page's whole first run. Removing the refresh inside
  // installCoreNamed fails the next three assertions with
  // "package Seeeduino not found".
  await byId.get("core-install-nrf52").onclick();
  await waitFor(() => !byId.get("core-install-nrf52").disabled, "the install to finish", 600000);
  // The fake DOM joins log lines without a separator, so this asserts the
  // exact sentence the page writes rather than a pattern across lines.
  const indexRead = log().includes("indexes/nrf52/nrf52_index.json STATUS_UPDATED");
  check(
    indexRead,
    "the install read the nRF52 index through the page's own shim" +
      (indexRead ? "" : ": " + log().slice(-300)),
  );
  check(
    log().includes("Installed Seeeduino:nrf52"),
    "the core installed" + (log().includes("Installed") ? "" : ": " + log().split("\n").slice(-6).join(" | ")),
  );

  console.log("\nCompile");
  byId.get("compile-board").value = FQBN;
  byId.get("compile-board").onchange();
  check(byId.get("compile-fqbn").value === FQBN, "choosing the board sets the FQBN");
  await byId.get("compile").onclick();
  const text = byId.get("compile-out").textContent;
  const compileStatus = byId.get("compile-status").textContent;
  if (!/bytes of flash/.test(compileStatus) || verbose) {
    console.log("  status: " + compileStatus);
    console.log(text.split("\n").slice(-40).join("\n"));
  }
  check(
    /Sketch uses \d+ bytes/.test(text),
    "the CLI reported the program size" + (/Sketch uses/.test(text) ? "" : ": " + text.slice(-600)),
  );
  check(
    !/link failed|undefined reference|no implementation/.test(text),
    "the build has no unresolved symbols or unanswered tools",
  );

  // The build directory is named after a hash of the sketch path, so it is
  // found the way the page finds it: the newest directory holding an ELF.
  const fsp = (name, ...args) =>
    new Promise((resolve, reject) => {
      globalThis.fs[name](...args, (error, value) => (error ? reject(error) : resolve(value)));
    });
  let buildPath = null;
  for (const name of await fsp("readdir", SKETCHES)) {
    const candidate = SKETCHES + "/" + name;
    if (await fsp("stat", candidate + "/Sketch.ino.elf").then(() => true, () => false)) {
      buildPath = candidate;
      break;
    }
  }
  check(buildPath !== null, "the build left a directory with an ELF [" + SKETCHES + "]");

  const readBuild = async (suffix) => {
    const target = buildPath + "/Sketch.ino." + suffix;
    const fd = await fsp("open", target, "r", 0o644);
    try {
      const stat = await fsp("fstat", fd);
      const buffer = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = await fsp("read", fd, buffer, offset, buffer.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      return buffer;
    } finally {
      await fsp("close", fd);
    }
  };

  console.log("\nThe ELF and the image inside it");
  const elf = await readBuild("elf");
  check(
    elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46,
    "the ELF starts with its magic",
  );
  const machine = elf[18] | (elf[19] << 8);
  check(machine === 40, "the ELF targets ARM [" + machine + "]");
  const entry = elf[24] | (elf[25] << 8) | (elf[26] << 16) | (elf[27] << 24);
  check((entry & 1) === 1, "the entry point is a Thumb address [0x" + entry.toString(16) + "]");

  const hexBytes = await readBuild("hex");
  const hex = new TextDecoder().decode(hexBytes);
  const lines = hex.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
  check(lines.at(-1) === ":00000001FF", "the image ends with the EOF record");
  const records = lines.map((line) => {
    const body = line.slice(1);
    let sum = 0;
    for (let i = 0; i < body.length; i += 2) sum = (sum + parseInt(body.slice(i, i + 2), 16)) & 0xff;
    return { line, sum };
  });
  const badChecksum = records.filter((record) => record.sum !== 0);
  check(
    badChecksum.length === 0,
    "every record's checksum adds to zero" +
      (badChecksum.length ? " [first: " + badChecksum[0].line + "]" : ""),
  );

  // The vector table is located from the ELF rather than assumed to be the
  // first record: an extended-address record leads this image.
  const words = [];
  let base = 0;
  for (const { line } of records) {
    const count = parseInt(line.slice(1, 3), 16);
    const address = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    const data = line.slice(9, 9 + count * 2);
    if (type === 0) {
      for (let i = 0; i < count; i += 1) {
        words.push({ address: base + address + i, value: parseInt(data.slice(i * 2, i * 2 + 2), 16) });
      }
    } else if (type === 2) {
      base = parseInt(data.slice(0, 4), 16) * 16;
    } else if (type === 4) {
      base = parseInt(data.slice(0, 4), 16) * 65536;
    }
  }
  check(words.length > 1000, "the image carries data [" + words.length + " bytes]");
  const image = new Map(words.map((word) => [word.address, word.value]));
  const at = words.findIndex(
    (word) =>
      image.get(word.address) === (entry & 0xff) &&
      image.get(word.address + 1) === ((entry >> 8) & 0xff) &&
      image.get(word.address + 2) === ((entry >> 16) & 0xff) &&
      image.get(word.address + 3) === ((entry >> 24) & 0xff),
  );
  check(at > 0, "the reset handler appears in the image (at word " + at + ")");
  if (at > 0) {
    const spWord = words[at - 4];
    const sp =
      spWord.value |
      (image.get(spWord.address + 1) << 8) |
      (image.get(spWord.address + 2) << 16) |
      (image.get(spWord.address + 3) << 24);
    check(
      sp >= 0x20000000 && sp <= 0x20040000 && sp % 8 === 0,
      "the word before the reset handler is the initial stack pointer [0x" + (sp >>> 0).toString(16) + "]",
    );
  }

  console.log("\nThe DFU package the page offers");
  const zipLink = byId.get("zip-download");
  check(!zipLink.hidden, "the DFU download link is shown");
  check(zipLink.download === "Sketch.ino.zip", "the link is named after the project");
  const zipBlob = downloads.get(zipLink.href);
  check(zipBlob !== undefined, "the page built a blob for the DFU package");
  const zip = zipBlob ? new Uint8Array(await zipBlob.arrayBuffer()) : new Uint8Array();
  check(zip[0] === 0x50 && zip[1] === 0x4b, "the package starts with a zip local header");
  const zipText = new TextDecoder("latin1").decode(zip);
  for (const name of ["manifest.json", "Sketch.ino.dat", "Sketch.ino.bin"]) {
    check(zipText.includes(name), "the package holds " + name);
  }
  const manifestAt = zipText.indexOf("manifest.json") + "manifest.json".length;
  check(
    /"application":\{"bin_file"|"application": \{/.test(zipText.slice(manifestAt, manifestAt + 400)) ||
      zipText.includes("bin_file"),
    "the manifest names the application binary",
  );

  console.log("\nThe .hex download still works beside it");
  const hexLink = byId.get("hex-download");
  check(!hexLink.hidden, "the .hex link is shown");
  check(downloads.has(hexLink.href), "the page built a blob for the .hex");

  console.log("\nall checks passed");
}

main().catch((error) => {
  console.log(error.stack || String(error));
  realProcess.exit(1);
});
