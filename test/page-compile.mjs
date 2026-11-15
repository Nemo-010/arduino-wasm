// The page's compile path, end to end: the shipped index, the shipped wasm
// toolchain, the page's own index shim, its own asset loader, and its own
// buttons. The DOM and the browser are fake (test/dom.mjs); the CLI, the
// compiler, the driver and the filesystem are the real ones.
//
// Nothing here reaches a socket: the shipped index lives under web/indexes/avr,
// its URLs point at a synthetic origin, and the page maps that origin onto its
// own directory. An attempt to fetch anything else fails loudly.
//
// Run with: node test/page-compile.mjs

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

const AVR_ORIGIN = "https://arduino-wasm.invalid";
const AVR_INDEX_URL = AVR_ORIGIN + "/indexes/avr/package_index.json";

function requireFiles() {
  const required = [
    "arduino-cli.wasm",
    "tools/avr/cc1plus.wasm.gz",
    "tools/avr/sysroot.tar.gz",
    "indexes/avr/package_index.json",
    "indexes/avr/avr-1.8.6.tar.bz2",
  ];
  return required;
}

async function main() {
  const missing = [];
  for (const name of requireFiles()) {
    try {
      await readFile(path.join(web, name));
    } catch (error) {
      missing.push(name);
    }
  }
  if (missing.length) {
    console.log("skipping: the page's assets are not here: " + missing.join(", "));
    console.log("  build them with: python3 scripts/update.py && python3 scripts/fetch-avr-tools.py && python3 scripts/make-avr-index.py --out web/indexes/avr --base-url " + AVR_ORIGIN + "/indexes/avr/");
    realProcess.exit(2);
  }

  const { document, byId } = await buildDocument({ baseURI: WEB_INDEX_URL });
  installBrowserGlobals({
    document,
    config: {
      // Empty means "the index this page ships", which is the point of the test.
      "arduino.index.default": "",
      "arduino.index.extra": "",
      "arduino.index.library": "",
    },
  });
  installXhr({ root: web });

  // The page's own bytes come from disk. Anything else is a request this test
  // has no answer for, and saying so is better than a silent network call.
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

  // Capture what the page hands to the download link.
  let downloaded = null;
  URL.createObjectURL = (blob) => {
    downloaded = blob;
    return "blob:captured";
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
    byId.get("index-default").value === AVR_INDEX_URL,
    "the default index is the one this page ships",
  );
  if (verbose) console.log(log());

  console.log("\nInstall arduino:avr from the shipped index");
  await byId.get("update").onclick();
  check(
    log().includes("package_index.json") && log().includes("STATUS_UPDATED"),
    "the shipped package index was read through the page's own shim",
  );
  await byId.get("core-install-avr").onclick();
  await waitFor(() => !byId.get("core-install-avr").disabled, "the install to finish", 180000);
  check(log().includes("Installed arduino:avr"), "the core installed");

  console.log("\nCompile");
  byId.get("compile-fqbn").value = "arduino:avr:uno";
  const sketch = byId.get("sketch").value;
  check(/void loop\(\)/.test(sketch), "the page starts with a sketch in the editor");
  await byId.get("compile").onclick();
  const text = byId.get("compile-out").textContent;
  const compileStatus = byId.get("compile-status").textContent;
  if (!/bytes of flash/.test(compileStatus) || verbose) {
    console.log("  status: " + compileStatus);
    console.log(text.split("\n").slice(-40).join("\n"));
  }
  check(/Sketch uses \d+ bytes/.test(text), "the CLI reported the program size");
  check(/^\d+ bytes of flash, [\d.]+ s$/.test(compileStatus), "the page shows bytes and seconds: " + compileStatus);

  console.log("\nThe .hex the page offers");
  const link = byId.get("hex-download");
  check(!link.hidden, "the download link is shown");
  check(link.download === "Sketch.ino.hex", "the link is named after the project");
  check(downloaded !== null, "the page built a blob for the download");
  const hex = downloaded ? await downloaded.text() : "";
  // The wasm objcopy writes CRLF, which every loader accepts; a record is what
  // sits between the terminators, so the carriage return is stripped here.
  const records = hex.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
  check(records.length > 50, "the image has records [" + records.length + "]");
  const bad = records.filter((line) => !line.startsWith(":") || line.length % 2 !== 1);
  check(
    bad.length === 0,
    "every record is an Intel HEX line" +
      (bad.length ? ` [${bad.length} bad, first: ${JSON.stringify(bad[0])}]` : ""),
  );
  check(records.at(-1) === ":00000001FF", "the image ends with the EOF record");
  check(records[0].startsWith(":100000000C94"), "the image starts with the AVR reset vector: " + records[0].slice(0, 24));

  console.log("\nall checks passed");
}

main().catch((error) => {
  console.log(error.stack || String(error));
  realProcess.exit(1);
});
