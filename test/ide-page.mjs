// Compile an Arduino sketch through the IDE's own UI, in a real browser.
//
// This is the end-to-end check for the thing the page is for: the Electron
// Arduino IDE's frontend, running as a webpage, with its own backend services
// answering from the wasm CLI. Nothing here is a stand-in -- the page boots the
// published bundle, the frontend asks its Board Manager to install the AVR
// platform (downloading the tool archives the shipped index advertises), creates
// a new sketch, and compiles it. The assertion is the compile summary's own
// section sizes.
//
// CI builds the tree just before it runs this test. Locally it needs a built
// IDE tree (`python3 scripts/build-ide.py`) and a browser. Measured here:
// 135 s end to end on 12 cores.
//
// Run: node test/ide-page.mjs [url]
// With a URL it grades that deployed page instead, over HTTP; NETWORK=1 is
// required so a network run is never accidental.
// Exit: 0 pass, 1 a check failed, 2 a precondition is missing.

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const liveUrl = process.argv[2] || "";
if (liveUrl && process.env.NETWORK !== "1") {
  console.log("skipped: NETWORK=1 is required to grade a live URL");
  process.exit(2);
}
const page = liveUrl || join(root, "web", "ide", "index.html");
if (!liveUrl && !existsSync(page)) {
  console.log("missing: " + page);
  console.log("build it first: python3 scripts/build-ide.py && python3 scripts/build-ide-services.py");
  process.exit(2);
}
const shot = join(root, "build", liveUrl ? "ide-live.png" : "ide-page.png");

const { launch } = await import(pathToFileURL(join(root, "test", "cdp.mjs")).href);

// A first boot wants a library index. The page cannot reach the host that
// publishes the real one from here, so the URL the product reads is pointed at
// arduino-cli's own testdata for the version this page builds from -- the same
// fixture `test/page-compile.mjs` uses. It is a configuration value the product
// documents, not a test-only switch.
const LIBRARY_INDEX = "https://raw.githubusercontent.com/arduino/arduino-cli/v1.6.0/commands/testdata/libraries/test1/library_index.json";

// The job runs inside the page. It is fired into `window.__job` and polled,
// because the debugger's probe cannot await a promise.
const job = `
window.__job = { stage: 'waiting', done: false, error: null, summary: null, sketch: null };
(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (!window.__inpageTargets || !window.__inpageTargets['/services/core-service']) await sleep(200);
    window.__job.stage = 'install';
    await window.__inpageTargets['/services/boards-service'].install({
      item: { id: 'arduino:avr', availableVersions: ['1.8.6'], installable: true, types: ['Arduino'] },
    });
    window.__job.stage = 'sketch';
    const sketch = await window.__inpageTargets['/services/sketches-service'].createNewSketch();
    window.__job.sketch = { name: sketch.name, uri: sketch.uri, mainFileUri: sketch.mainFileUri };
    window.__job.stage = 'compile';
    window.__job.summary = await window.__inpageTargets['/services/core-service'].compile({
      sketch,
      fqbn: 'arduino:avr:uno',
      sourceOverride: {},
      compilerWarnings: 'none',
      optimizeForDebug: false,
      verbose: false,
      exportBinaries: false,
      clean: false,
    });
    window.__job.stage = 'done';
  } catch (error) {
    window.__job.stage = 'error';
    window.__job.error = String((error && error.stack) || error).slice(0, 1500);
  }
  window.__job.done = true;
})();
'fired';
`;

// What the user sees, read after the boot: the IDE's own chrome, the sketch it
// opened by itself, and the text in the editor. A page that only answers RPCs
// would pass the compile checks below and fail these.
const dom = `JSON.stringify({
  title: document.title,
  splash: !!document.querySelector('.theia-preload'),
  editors: document.querySelectorAll('.theia-editor, .monaco-editor').length,
  menuLabels: window.__menuBar ? window.__menuBar.menus.map(m => m.title && m.title.label) : null,
  menuText: window.__menuBar ? window.__menuBar.node.textContent : '',
  text: document.body.innerText,
})`;

const profile = "/tmp/arduino-ide-page-" + process.pid;
let failures = 0;
const ok = (name, condition, detail) => {
  if (condition) console.log("ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail === undefined ? "" : "\n    " + detail)); }
};

const read = `JSON.stringify({
  stage: window.__job && window.__job.stage,
  done: window.__job && window.__job.done,
  error: window.__job && window.__job.error,
  sketch: window.__job && window.__job.sketch,
  sections: window.__job && window.__job.summary && window.__job.summary.executableSectionsSize
    ? window.__job.summary.executableSectionsSize.map((s) => ({ name: s.name, size: s.size, maxSize: s.maxSize }))
    : null,
  keys: window.__job && window.__job.summary ? Object.keys(window.__job.summary) : null,
  real: window.__inpageReal,
  missing: (window.__missing || []).length,
  cli: !!window.__arduinoCLIReady,
  cliError: window.__arduinoCLIError ? String(window.__arduinoCLIError).slice(0, 300) : null,
})`;

let result = null;
try {
  result = await launch({
    url: liveUrl || pathToFileURL(page).href,
    waitMs: 40000,
    profile,
    shot,
    preScript: `try { localStorage.setItem('arduino.index.library', ${JSON.stringify(LIBRARY_INDEX)}); } catch (e) {}`,
    steps: [
      { wait: 45000, evaluate: dom },
      { wait: 5000, evaluate: job },
      {
        until: (value) => String(value).includes('"done":true'),
        timeout: 900000,
        wait: 15000,
        evaluate: read,
      },
      {
        wait: 500,
        evaluate: `(function(){
          var bar = window.__menuBar;
          if (!bar) return JSON.stringify({ before: null });
          var before = !bar.isHidden;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
          var down = !bar.isHidden;
          window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
          return JSON.stringify({ before: before, down: down, up: !bar.isHidden });
        })()`,
      },
    ],
  });
} catch (error) {
  rmSync(profile, { recursive: true, force: true });
  console.log("  FAIL the page could not be driven: " + String(error && error.message).slice(0, 300));
  console.log("1 failed");
  process.exit(1);
}
rmSync(profile, { recursive: true, force: true });

const state = result.state;
// Step 2 is the compile result; the last step is the Alt toggle, which must
// not be mistaken for the job's summary.
const raw = state.steps[2];
let seen = null;
try { seen = JSON.parse(String(raw)); } catch (error) { seen = null; }

let ui = null;
try { ui = JSON.parse(String(state.steps[0])); } catch (error) { ui = null; }
ok("the IDE's own UI rendered", ui !== null && ui.splash === false, ui === null ? String(state.steps[0]).slice(0, 300) : "splash: " + ui.splash);
if (ui) {
  const labels = ui.menuLabels || [];
  ok(
    "the IDE's top bar is back",
    labels.filter(Boolean).length >= 4 && /File/.test(ui.menuText) && /Sketch/.test(ui.menuText),
    JSON.stringify(labels) + ' text: ' + String(ui.menuText).slice(0, 100),
  );
  let alt = null;
  try { alt = JSON.parse(String(state.steps[state.steps.length - 1])); } catch { alt = null; }
  ok("Alt toggles the top bar", !!alt && alt.before === true && alt.down === false, JSON.stringify(alt));
}
if (ui) {
  ok("the window titles the sketch the IDE opened", /sketch_\w+ \| Arduino IDE/.test(ui.title), ui.title);
  ok("an editor was opened for the sketch", ui.editors > 0, String(ui.editors));
  // The tab's own class is Theia's business and has changed between versions
  // ("lm-TabBar-tab" is not what this build renders), so this asserts what the
  // user sees: the file's name and its source, in the page.
  // Monaco's rendered text uses non-breaking spaces for its whitespace, so the
  // source is compared with those normalised: measured, `void\u00a0setup()`.
  const source = String(ui.text).replace(/\u00a0/g, " ");
  ok("the sketch's source is displayed", /void setup\(\)/.test(source) && source.includes("void loop()"), source.slice(0, 240));
}
ok("the page reported a compile result", seen !== null, String(raw).slice(0, 400));
if (seen) {
  ok("the page's own services answered (no stub fall-through)", seen.real === "bundled", String(seen.real));
  ok("every RPC the boot made had an implementation", seen.missing === 0, String(seen.missing));
  ok("the wasm CLI was started by the page", seen.cli === true, String(seen.cliError));
  ok("the compile reached its last stage", seen.stage === "done", String(seen.error || seen.stage));
  ok("the compile reported no error", seen.error === null, String(seen.error));
  ok("the sketch the page created is a real sketch", seen.sketch !== null && /\.ino$/.test(String(seen.sketch.mainFileUri)), JSON.stringify(seen.sketch));
  const sections = seen.sections || [];
  const text = sections.find((s) => s.name === "text");
  const data = sections.find((s) => s.name === "data");
  ok("the summary carries compiled section sizes", sections.length > 0, JSON.stringify(seen.keys));
  // A Blink sketch is about 2 KB of program on an Uno, and its limits are the
  // board's own: 32 KB of flash, 2 KB of RAM. Zero would mean nothing compiled;
  // more than the limit would mean the wrong board.
  ok("the compiled program has bytes", !!text && text.size > 0, JSON.stringify(text));
  ok("the program fits in the Uno's flash", !!text && text.maxSize === 32256 && text.size < text.maxSize, JSON.stringify(text));
  ok("the compiled data section has bytes", !!data && data.size > 0, JSON.stringify(data));
  ok("the data fits in the Uno's RAM", !!data && data.maxSize === 2048 && data.size < data.maxSize, JSON.stringify(data));
}

const exceptions = (state.exceptions || []).map((e) => String(e));
if (exceptions.length) console.log("note: " + exceptions.length + " page exception(s): " + exceptions.slice(-3).map((e) => e.slice(0, 160)).join(" | "));

console.log(failures === 0 ? "all checks passed" : failures + " failed");
process.exitCode = failures === 0 ? 0 : 1;
