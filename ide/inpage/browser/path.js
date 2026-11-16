// The page's path implementation is POSIX, which is what the CLI and its tools
// were measured with. Forward every call to it so there is one implementation.
function shim() {
  const value = globalThis.path;
  if (!value) {
    throw new Error(
      "globalThis.path is not installed: the page's filesystem shim must be created before the IDE's services run",
    );
  }
  return value;
}

const names = [
  "basename",
  "delimiter",
  "dirname",
  "extname",
  "format",
  "isAbsolute",
  "join",
  "normalize",
  "parse",
  "posix",
  "relative",
  "resolve",
  "sep",
  "toNamespacedPath",
  "win32",
];

const facade = {};
for (const name of names) {
  facade[name] = function (...args) {
    const value = shim()[name];
    if (value === undefined) {
      throw new Error("path." + name + " is not provided by the page's filesystem shim");
    }
    return typeof value === "function" ? value.apply(shim(), args) : value;
  };
}

module.exports = facade;
module.exports.default = facade;
