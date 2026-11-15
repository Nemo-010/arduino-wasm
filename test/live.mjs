// The deployed page, in a real browser, over HTTP.
//
// Every other page test fakes the browser (test/dom.mjs) and reaches its files
// through a stubbed XHR. That leaves one claim untested: that the page served
// by GitHub Pages loads its own assets, fetches its shipped indexes, installs a
// core into IndexedDB and compiles a sketch — in Chrome, from the origin it is
// actually served from. This is that claim.
//
// It needs the Electrosphere, so it is opt-in:
//
//   NETWORK=1 node test/live.mjs [url]
//
// The default URL is the deployed site. Chrome and its path come from
// test/cdp.mjs (`ARDUINO_WASM_CHROME`).
//
// What it does not cover: WebUSB and WebSerial need a device on the other end,
// so the upload path is not exercised; and the library index lives on
// downloads.arduino.cc, which refuses this page, so its failure is expected and
// asserted as such rather than treated as a defect.

import { rmSync } from "node:fs";

import { launch } from "./cdp.mjs";
import { check } from "./dom.mjs";

const DEFAULT_URL = "https://nemo-010.github.io/arduino-wasm/";
const realProcess = process;

if (realProcess.env.NETWORK !== "1") {
  console.log("skipped: NETWORK=1 is not set, and this test needs the Electrosphere");
  realProcess.exit(2);
}

const url = realProcess.argv[2] || DEFAULT_URL;
const FQBN = "Seeeduino:nrf52:xiaonRF52840";
const INSTALL_TIMEOUT = 600000;
const COMPILE_TIMEOUT = 900000;

const text = (id) => `document.getElementById(${JSON.stringify(id)}).textContent`;
const statusText = text("compile-status");
const compileOut = text("compile-out");  // whole: the board line is at the head

// Only a tail is read while polling. The install log grows past 100 KB, and
// shipping all of it through the debugging pipe every few seconds turned a
// 60-second install into a 16-minute wait.
const logTail = 'document.getElementById("log").textContent.slice(-600)';
const logText = 'document.getElementById("log").textContent.slice(-4000)';

// A fresh profile every run: the platform lives in IndexedDB, and a profile
// that kept it would skip the first run this test exists to measure.
const profile = "/tmp/arduino-wasm-live-profile";
rmSync(profile, { recursive: true, force: true });

const started = Date.now();
const result = await launch({
  url,
  waitMs: 30000,
  profile,
  shot: "/tmp/live.png",
  steps: [
    {
      evaluate: `JSON.stringify({
        title: document.title,
        nrf52: !!document.getElementById("core-install-nrf52"),
      })`,
    },
    { evaluate: 'document.getElementById("core-install-nrf52").click(), "clicked"' },
    {
      wait: 5000,
      timeout: INSTALL_TIMEOUT,
      evaluate: logTail,
      // Not /failed/: the boot log already carries "Download failed" for the
      // library index, which would stop this at the first poll and grade the
      // page mid-install.
      until: (value) =>
        typeof value === "string" &&
        /Installed Seeeduino:nrf52|package Seeeduino not found|Installation failed/.test(value),
    },
    {
      // installCoreNamed re-enables the button a task after the log line, so the
      // state is read once that task has run.
      wait: 2000,
      evaluate: `JSON.stringify({
        installDisabled: document.getElementById("core-install-nrf52").disabled,
        status: ${statusText},
      })`,
    },
    { evaluate: logText },
    {
      // The board select is the page's own way of choosing what to compile for:
      // a fresh profile has no AVR core, so the default board cannot build.
      evaluate: `(function () {
        const select = document.getElementById("compile-board");
        select.value = ${JSON.stringify(FQBN)};
        select.dispatchEvent(new Event("change"));
        return document.getElementById("compile-fqbn").value;
      })()`,
    },
    { evaluate: 'document.getElementById("compile").click(), "clicked"' },
    {
      wait: 5000,
      timeout: COMPILE_TIMEOUT,
      evaluate: statusText,
      until: (value) => typeof value === "string" && /bytes of flash|failed|Error/.test(value),
    },
    { evaluate: statusText },
    { evaluate: compileOut },
    {
      evaluate: `JSON.stringify({
        hex: typeof document.getElementById("hex-download").getAttribute("href"),
        hexHidden: document.getElementById("hex-download").hidden,
      })`,
    },
  ],
});

const elapsed = Math.round((Date.now() - started) / 1000);
console.log(`live: ${url} in ${elapsed} s`);

const [
  boot,
  clickedInstall,
  installTail,
  installState,
  installLog,
  chosenFqbn,
  clickedCompile,
  compileStatus,
  compileStatusAgain,
  compileLog,
  downloadState,
] = result.state.steps;

const installSaw = String(installLog) + String(installTail);

check(/arduino/i.test(JSON.parse(boot).title), "the page is the one this repo ships: " + JSON.parse(boot).title);
check(JSON.parse(boot).nrf52, "the page offers the XIAO install button");
check(clickedInstall === "clicked", "the install button clicked");

// The failure text is checked first, so a failed install reports the page's own
// words rather than an assertion that says only "not installed".
check(
  !installSaw.includes("package Seeeduino not found"),
  "the install found the platform in the shipped index" +
    (installSaw.includes("package Seeeduino not found")
      ? ": the page has no index — the install did not refresh it"
      : ""),
);
check(
  installSaw.includes("Installed Seeeduino:nrf52"),
  "the core installed from a fresh profile: " + installSaw.replace(/\s+/g, " ").slice(-300),
);
check(!JSON.parse(installState).installDisabled, "the install button was re-enabled");

check(chosenFqbn === FQBN, "choosing the board set the FQBN: " + chosenFqbn);
check(clickedCompile === "clicked", "the compile button clicked");
check(
  typeof compileStatus === "string" && /bytes of flash/.test(compileStatus),
  "the compile reported the flash usage: " + compileStatus,
);
check(
  typeof compileStatusAgain === "string" && /bytes of flash/.test(compileStatusAgain),
  "the compile status held: " + compileStatusAgain,
);
check(
  typeof compileLog === "string" && /Sketch uses \d+ bytes/.test(compileLog),
  "the CLI reported the program size: " + String(compileLog).slice(-300),
);
check(
  typeof compileLog === "string" && !/link failed|undefined reference|no implementation/.test(compileLog),
  "the build has no unresolved symbols or unanswered tools",
);
const downloads = JSON.parse(downloadState);
check(downloads.hex === "string" && !downloads.hexHidden, "the page offers the .hex for download");

// What the page must not do. The library index is the one request allowed to
// fail: it is a 30 MB archive on downloads.arduino.cc, which sends no CORS
// header to this page, and the page reports it in its log instead of stopping.
const allowed = "https://downloads.arduino.cc/libraries/library_index.tar.bz2";
const unexpected = result.failed.filter((entry) => entry.url !== allowed);
check(
  unexpected.length === 0,
  "every request the page made succeeded except the library index" +
    (unexpected.length ? ": " + JSON.stringify(unexpected.slice(0, 4)) : ""),
);
check(
  result.exceptions.length === 0,
  "the page raised no uncaught exception: " + JSON.stringify(result.exceptions.slice(0, 3)),
);
check(result.state.errors === "[]", "no error event fired: " + result.state.errors);

console.log(`\nall checks passed in ${elapsed} s (screenshot /tmp/live.png)`);
