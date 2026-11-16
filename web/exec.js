// The page side of arduino-cli's exec seam.
//
// arduino-cli runs its recipes through go-paths-helper, which wraps os/exec. The
// wasm build has no os/exec, so overlay/wasm/exec_js.go hands every command line
// to `globalThis.arduinoExec(request, callback)` instead:
//
//   request  = { args: string[], dir: string, env: string[] }
//   callback = (result) => void, with { code, stdout, stderr }
//
// This module answers that call with a toolchain driver and writes the files it
// produced into the same filesystem arduino-cli reads, so a compile finishes the
// way it would on a machine with the real toolchain installed. Which driver
// answers is the caller's choice: the AVR one and the ARM one differ in
// everything except this plumbing.

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

// web/nodefs.js is node-style: open/read/write/close, callback based. The driver
// wants whole files, so the whole-file helpers live here rather than in the
// driver, which keeps the driver testable against any store.
export function createVfsAccess(nodefs) {
  const fs = nodefs.fs;

  async function readFile(path) {
    let fd;
    try {
      fd = await call(fs, "open", path, "r", 0o644);
    } catch (error) {
      return null;
    }
    try {
      const stat = await call(fs, "fstat", fd);
      const buffer = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = await call(fs, "read", fd, buffer, offset, buffer.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      return buffer.subarray(0, offset);
    } finally {
      await call(fs, "close", fd);
    }
  }

  async function writeFile(path, data) {
    const fd = await call(fs, "open", path, "w", 0o644);
    try {
      if (data.length) {
        await call(fs, "write", fd, data, 0, data.length, null);
      }
    } finally {
      await call(fs, "close", fd);
    }
  }

  async function listDir(path) {
    try {
      return await call(fs, "readdir", path);
    } catch (error) {
      return null;
    }
  }

  async function isDirectory(path) {
    try {
      const stat = await call(fs, "stat", path);
      return Boolean(stat && stat.isDirectory());
    } catch (error) {
      return false;
    }
  }

  return { readFile, writeFile, listDir, isDirectory };
}

export function createExec({ nodefs, readAsset, readWasm, importModule, createDriver, log }) {
  const vfs = createVfsAccess(nodefs);

  // Built on first use: parsing a sysroot costs a decompression, and a session
  // that never compiles should not pay for it.
  let driverPromise = null;
  function driver() {
    if (!driverPromise) {
      driverPromise = createDriver({
        readAsset,
        // The AVR driver asks for every asset by name; the ARM one separates
        // the sysroot from the tool bodies. A caller that has only one reader
        // gets the same reader twice rather than a silent undefined.
        readWasm: readWasm ?? readAsset,
        importModule,
        readFile: vfs.readFile,
        listDir: vfs.listDir,
        isDirectory: vfs.isDirectory,
        log,
      });
    }
    return driverPromise;
  }

  return async function arduinoExec(request, callback) {
    let result;
    try {
      const running = await driver();
      result = await running.run(request);
      for (const file of result.files) {
        await vfs.writeFile(file.path, file.data);
      }
    } catch (error) {
      // The Go side reads stdout, stderr and the exit code, and nothing else.
      // A crash reported only in `error` reached the CLI as "exit status 1"
      // with no text, so a driver exception looked exactly like a compiler
      // rejecting the source. Put it where the CLI and the IDE's output panel
      // both look.
      const detail = "arduinoExec failed: " + (error && error.stack ? error.stack : String(error));
      callback({
        code: 1,
        stdout: "",
        stderr: detail + "\n",
        error: detail,
      });
      return;
    }
    callback({
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  };
}

// The Go side looks the runner up as a property of the global object on every
// call, so installing it is all that is needed, and a page that has not built
// the toolchain gets the honest "not implemented on js" error instead.
export function installExec(options) {
  globalThis.arduinoExec = createExec(options);
  return globalThis.arduinoExec;
}
