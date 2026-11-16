// The page's `process` must not tell Emscripten it is Node.
//
// Why this test exists: the IDE bundle reads `process.versions.node`, so the
// page's `process` carries it. Emscripten reads the same flag to decide whether
// it is in Node, and its Node branch starts with `await import("module")` --
// a bare specifier that no browser can resolve. Measured on the assembled page:
// `avr-g++` died with `Failed to resolve module specifier 'module'` and the
// compile never ran. `web/tool-common.js#createToolInstance` hides the version
// for the length of one instantiation, which is the fix this test grades.
//
// A Node-hosted test cannot see the browser's failure (Node resolves
// `import("module")`), which is why this asserts the helper's *property* -- the
// version is gone while the factory is called, and back afterwards -- instead of
// trying to reproduce the browser's module resolution.

import { createToolInstance } from "../web/tool-common.js";

let failures = 0;
const ok = (name, condition, detail) => {
  if (condition) console.log("ok  " + name);
  else { failures++; console.log("FAIL " + name + (detail === undefined ? "" : "\n  " + detail)); }
};

const realProcess = process;

// 1. During the factory call the version is gone; it comes back afterwards.
{
  const saved = { node: realProcess.versions.node };
  let seen = "not called";
  const made = await createToolInstance((options) => {
    seen = realProcess.versions;
    return { options };
  }, { wasmBinary: 1 });
  ok("the factory sees no process.versions", seen === undefined, "saw: " + JSON.stringify(seen));
  ok("the factory's own argument arrives unchanged", made && made.options.wasmBinary === 1);
  ok("process.versions is restored with the same object",
    realProcess.versions !== undefined && realProcess.versions.node === saved.node,
    "saw: " + JSON.stringify(realProcess.versions));
}

// 2. A factory that throws still gets the version put back.
{
  let threw = false;
  try {
    await createToolInstance(() => { throw new Error("planted"); }, {});
  } catch (error) {
    threw = String(error.message) === "planted";
  }
  ok("a throwing factory propagates its error", threw);
  ok("a throwing factory still restores process.versions", realProcess.versions !== undefined);
}

// 3. A host with no `versions` is left alone: nothing is deleted, nothing added.
{
  const host = { env: {} };
  const before = Object.keys(host).length;
  const original = realProcess;
  globalThis.process = host;
  try {
    await createToolInstance(() => {
      ok("a host without versions is not given one", !("versions" in host), JSON.stringify(host));
    }, {});
  } finally {
    globalThis.process = original;
  }
  ok("a host without versions is unchanged", Object.keys(host).length === before);
  ok("the real process object is the one this test started with", globalThis.process === original);
}

// 4. The value handed to the factory is the version's absence, not a false one:
// a truthiness-only check would pass on `null`, which Emscripten's `?.node`
// chain would not.
{
  let seenType = "not called";
  await createToolInstance(() => {
    seenType = typeof realProcess.versions;
  }, {});
  ok("the factory sees the property absent, not merely falsy", seenType === "undefined", seenType);
}

console.log(failures === 0 ? "all checks passed" : failures + " failed");
realProcess.exitCode = failures === 0 ? 0 : 1;
