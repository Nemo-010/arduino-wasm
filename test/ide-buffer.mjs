// Guards how the page's services bundle gets `Buffer`.
//
// The extension's error parser calls `Buffer.concat(content).toString('utf8')`
// without importing anything, so the bundle has to provide `Buffer` to that
// module. Installing it on `globalThis` in the entry point also compiles, and it
// was measured to blank the IDE: with the global installed the page booted to
// `editors: 0`, and without it to `editors: 2`, three runs each. Some module in
// the frontend takes a different branch when a global `Buffer` exists, and the
// branch it takes leaves the editor empty.
//
// So the dependency goes to the modules that name it (webpack's ProvidePlugin)
// and never to the world. This test asserts those two facts about the sources,
// because the browser consequence cannot be reproduced in Node -- `test/ide-page.mjs`
// grades the consequence, and is the slower half of this pair.
//
// Run: node test/ide-buffer.mjs
// Exit: 0 pass, 1 a check failed, 2 a precondition is missing.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const realProcess = process;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "ide", "inpage", "browser", "entry.js");
const config = join(root, "ide", "inpage", "browser", "webpack.config.js");
const bundle = join(root, "build", "ide-services", "services.js");

let failures = 0;
function ok(condition, message, datum) {
  if (condition) {
    console.log("  ok  " + message);
    return;
  }
  failures += 1;
  console.log("  FAIL " + message);
  if (datum !== undefined) console.log("        " + JSON.stringify(datum));
}

for (const path of [entry, config]) {
  if (!existsSync(path)) {
    console.log("missing: " + path);
    realProcess.exit(2);
  }
}

const entrySource = await readFile(entry, "utf8");
const configSource = await readFile(config, "utf8");

// A global assignment is the defect: it is visible to every module in the page,
// including the frontend's, which is where the blank editor came from.
const assignments = [
  ...entrySource.matchAll(/globalThis\.Buffer\s*=|global\.Buffer\s*=|window\.Buffer\s*=/g),
].map((match) => match[0]);
ok(
  assignments.length === 0,
  "the entry point installs no global Buffer",
  assignments,
);

ok(
  /new webpack\.ProvidePlugin\(\{\s*Buffer:\s*\[\s*"buffer"\s*,\s*"Buffer"\s*\]\s*\}\)/.test(configSource),
  'the webpack config provides Buffer to the modules that name it',
);

// The generated bundle is what the page actually loads, so when it is on disk
// check that it agrees with the sources above. It is unminified on purpose
// (`optimization.minimize: false`), so the binding is readable.
if (existsSync(bundle)) {
  const built = await readFile(bundle, "utf8");
  const provided = built.match(/provided dependency \*\/ var Buffer = __webpack_require__\(\d+\)\["Buffer"\];/g) || [];
  ok(provided.length > 0, "the built bundle binds Buffer per module", provided.length);
  const globalAssign = [...built.matchAll(/globalThis\.Buffer\s*=/g)].map((match) => match[0]);
  ok(globalAssign.length === 0, "the built bundle assigns no global Buffer", globalAssign);
} else {
  console.log("  --  the built bundle is absent, so the artefact was not graded: " + bundle);
  console.log("      build it: python3 scripts/build-ide-services.py");
}

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
realProcess.exitCode = failures === 0 ? 0 : 1;
