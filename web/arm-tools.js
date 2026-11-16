// Running the ARM binutils, hosted in WebAssembly.
//
// The tools come from scripts/build-arm-tools.py: gas, ld, objcopy and ar for
// arm-none-eabi, built for wasm32 with Emscripten. Each is an ES module that
// exports a factory; this module makes one instance per invocation, writes the
// inputs into that instance's filesystem, calls main and reads the outputs back.
//
// One instance per call, not one per tool: a tool's own filesystem is where the
// arguments point, and a linker run must not see a previous run's leftovers.

import { createToolInstance, ensureParent, writeFile } from "./tool-common.js";

function readIfAny(FS, path) {
  const found = FS.analyzePath(path);
  if (!found.exists) return null;
  return FS.readFile(path);
}

export function createArmTools({ importModule, readWasm, note }) {
  const factories = new Map();
  const log = note || (() => {});

  async function factory(name) {
    if (!factories.has(name)) {
      const module = await importModule(name);
      const create = module.default || module.createTool;
      if (typeof create !== "function") throw new Error("arm tool " + name + " exports no factory");
      factories.set(name, create);
    }
    return factories.get(name);
  }

  // argv is passed to the tool's own main, so it is the tool's own syntax:
  // ["-mcpu=cortex-m4", "-mthumb", "-o", "/work/a.o", "/work/a.s"].
  async function run(name, argv, { files = [], outputs = [] } = {}) {
    const create = await factory(name);
    const wasmBinary = await readWasm(name + ".wasm");
    let stdout = "";
    let stderr = "";
    const instance = await createToolInstance(create, {
      wasmBinary,
      noInitialRun: true,
      noExitRuntime: true,
      print: (line) => { stdout += line + "\n"; },
      printErr: (line) => { stderr += line + "\n"; },
    });

    for (const file of files) writeFile(instance.FS, file.path, file.data);
    for (const path of outputs) {
      if (path && path !== "/dev/null") ensureParent(instance.FS, path);
    }

    let code = 0;
    try {
      // Emscripten's handleException catches ExitStatus and returns its status,
      // so a failing tool reports through the return value and throws nothing.
      // Measured: gas on an unknown -mcpu returns 1, throws null.
      const status = instance.callMain(argv);
      if (typeof status === "number") code = status;
    } catch (error) {
      // An abort inside the runtime still throws, and that is not an exit.
      if (error && typeof error.status === "number") code = error.status;
      else throw error;
    }
    // In Node, quit_ sets process.exitCode as well as returning the status,
    // which would make a passing run exit non-zero because one tool failed.
    if (typeof process !== "undefined" && typeof process.exitCode === "number" && process.exitCode !== 0) process.exitCode = 0;

    const written = [];
    for (const path of outputs) {
      if (!path || path === "/dev/null") continue;
      const data = readIfAny(instance.FS, path);
      if (data) written.push({ path, data });
      // An exit code of zero with no file would leave the caller using a path
      // that does not exist. Say so rather than returning quietly.
      else log("arm tool " + name + ": exit " + code + " but no " + path + " (stderr: " + stderr.slice(0, 400) + ")");
    }
    return { code, stdout, stderr, files: written };
  }

  // The two shapes a caller needs: one file in, one file out, and a chained
  // build where the second step reads what the first wrote.
  return { run };
}
