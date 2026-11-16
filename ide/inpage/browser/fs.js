// The extension's backend services call Node's `fs` directly. In the page the
// filesystem is `web/nodefs.js`, installed on globalThis because that is what
// the Go runtime and the CLI's tool drivers already use. One filesystem, not
// two: a service that wrote through its own shim would leave files the CLI
// cannot see.
//
// Each function looks the shim up when it is called, so it does not matter
// whether the page installed it before or after this module loaded.

function shim() {
  const value = globalThis.fs;
  if (!value) {
    throw new Error(
      "globalThis.fs is not installed: the page's filesystem shim must be created before the IDE's services run",
    );
  }
  return value;
}

const names = [
  "access",
  "accessSync",
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "close",
  "closeSync",
  "constants",
  "copyFile",
  "copyFileSync",
  "createReadStream",
  "createWriteStream",
  "exists",
  "existsSync",
  "fchmod",
  "fchmodSync",
  "fstat",
  "fstatSync",
  "fsync",
  "fsyncSync",
  "ftruncate",
  "ftruncateSync",
  "futimes",
  "futimesSync",
  "lchmod",
  "lchmodSync",
  "lchown",
  "lchownSync",
  "link",
  "linkSync",
  "lstat",
  "lstatSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "open",
  "openSync",
  "opendir",
  "opendirSync",
  "read",
  "readFile",
  "readFileSync",
  "readSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "readv",
  "readvSync",
  "realpath",
  "realpathSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "stat",
  "statSync",
  "statfs",
  "statfsSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "watch",
  "watchFile",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
  "writev",
  "writevSync",
];

// Node's `fs.realpath` and `fs.realpathSync` carry a `.native` twin, and
// callers reach for it by name. A wrapper that forwards only the call drops the
// property, and the call site dies with "realpath.native is not a function".
const NATIVE_NAMES = new Set(["realpath", "realpathSync"]);

const facade = {};
for (const name of names) {
  const wrapper = function (...args) {
    const value = shim()[name];
    if (value === undefined) {
      throw new Error("fs." + name + " is not provided by the page's filesystem shim");
    }
    return typeof value === "function" ? value.apply(shim(), args) : value;
  };
  if (NATIVE_NAMES.has(name)) {
    wrapper.native = function (...args) {
      const value = shim()[name];
      return (value.native || value).apply(shim(), args);
    };
  }
  facade[name] = wrapper;
}

// fs-extra and Theia call `fs.promises`. The page's shim speaks Node's callback
// API, so the promises are made from it rather than demanded of it.
facade.promises = new Proxy(
  {},
  {
    get(_target, name) {
      if (name === "then") {
        return undefined;
      }
      return function (...args) {
        const value = shim();
        if (value.promises && typeof value.promises[name] === "function") {
          return value.promises[name](...args);
        }
        if (typeof value[name] !== "function") {
          throw new Error("fs.promises." + String(name) + " is not provided by the page's filesystem shim");
        }
        return new Promise((resolve, reject) => {
          value[name](...args, (error, result) => (error ? reject(error) : resolve(result)));
        });
      };
    },
  },
);

module.exports = facade;
