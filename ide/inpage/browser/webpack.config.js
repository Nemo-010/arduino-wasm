// Bundles arduino-ide's browser-side backend services for the page.
//
// The extension's node classes are CommonJS compiled from TypeScript and import
// Node built-ins. None of those exist in a browser, so each one is answered by a
// module in this directory -- all of them thin, and all of them forwarding to
// the page's single filesystem shim rather than bringing a second one.
//
// Three aliases carry the real change:
//   `arduino-core-service-definition` -> the extension's own generated
//       `commands_grpc_pb.js`, so the client speaks the same service definition
//       the desktop IDE speaks.
//   `arduino-daemon-impl` -> a daemon that is already running, because the CLI
//       is the wasm module rather than a process.
//   `@grpc/grpc-js` -> its status enum and Metadata class, without a channel.
//
// The paths come from the build script, which knows where the IDE tree is.
const path = require("path");

const repo = process.env.ARDUINO_WASM_REPO;
const ide = process.env.ARDUINO_IDE_TREE;
if (!repo || !ide) {
  throw new Error("ARDUINO_WASM_REPO and ARDUINO_IDE_TREE must be set by the build script");
}
// This file is outside the IDE tree, so `webpack` is not resolvable from here by
// the usual walk up the directories: ask the tree that has it.
const webpack = require(path.join(ide, "node_modules", "webpack"));
const extension = path.join(ide, "arduino-ide-extension", "lib");
const shim = (name) => path.join(repo, "ide", "inpage", "browser", name);

const aliases = {
  "arduino-extension": extension,
  "arduino-core-service-definition": path.join(
    extension,
    "node",
    "cli-protocol",
    "cc",
    "arduino",
    "cli",
    "commands",
    "v1",
    "commands_grpc_pb.js",
  ),
  // The same file reached by its own relative import from
  // `core-client-provider.js`, which is why the absolute path is the key.
  [path.join(extension, "node", "arduino-daemon-impl")]: shim("daemon.js"),
  "arduino-daemon-impl": shim("daemon.js"),
  // The one module that opens a socket. Everything above it is upstream.
  // `ConfigServiceImpl` gets the CLI's configuration by running
  // `arduino-cli config ...` as a child process; the page answers those three
  // commands from the CLI's own RPCs instead.
  [path.join(extension, "node", "exec-util")]: shim("exec-util.js"),
  "exec-util": shim("exec-util.js"),
  [path.join(extension, "node", "arduino-core-service-client")]: shim("core-client.js"),
  "arduino-core-service-client": shim("core-client.js"),
  // `service-error.js` imports grpc-js for its status enum and its Metadata
  // class. Both are plain data; the channel is not.
  "@grpc/grpc-js": shim("grpc-status.js"),
  // `glob` is asked for two fixed sketchbook patterns; its own implementation
  // drags in url/stream/minipass polyfills to walk a filesystem that is not
  // there. The page walks its own tree instead.
  glob: shim("glob.js"),
  "fs/promises": shim("fs-promises.js"),
  // `library-service-impl.js` imports this index for `FileUri` alone, and the
  // index is the whole Node backend.
  "@theia/core/lib/node": shim("theia-node.js"),
  "@theia/core/lib/node/messaging": shim("refuse.js"),
  "@theia/core/lib/node/process-utils": shim("refuse.js"),
};

// Node's built-ins, answered by the smallest module that answers them.
const builtins = {
  fs: "fs.js",
  path: "path.js",
  os: "os.js",
  child_process: "child-process.js",
  crypto: "crypto.js",
  assert: "assert.js",
  constants: "fs.js",
  events: require.resolve("events", { paths: [path.join(ide, "node_modules")] }),
};
for (const [name, target] of Object.entries(builtins)) {
  aliases[name] = target.endsWith(".js") ? shim(target) : target;
}

module.exports = {
  mode: "production",
  devtool: false,
  target: "web",
  entry: shim("entry.js"),
  output: {
    path: process.env.ARDUINO_WASM_OUT || path.join(repo, "build", "ide-services"),
    filename: "services.js",
    // One artefact for both readers: `require()` in the Node tests, and a global
    // for the page, which loads this with a script tag and has no module loader.
    library: { type: "umd", name: "ArduinoIdeServices" },
    // Webpack's UMD wrapper reaches for `self`, which Node does not define. The
    // bundle is required by a Node test and loaded by a script tag in the page,
    // and `globalThis` is the one root both have.
    globalObject: "globalThis",
  },
  resolve: {
    extensions: [".js", ".json", ".mjs"],
    // Node's own order first: the nearest `node_modules` walking up from the
    // requesting file, so `config-service-impl.js` gets the js-yaml 3 the
    // extension declares (`safeLoad` is gone in 4, and the root has 4). The IDE
    // tree's root is the fallback, which is where the shims in this directory
    // find `@theia/*` -- they sit outside the tree and have no other way.
    modules: ["node_modules", path.join(ide, "node_modules")],
    alias: aliases,
  },
  plugins: [
    // Webpack reads `node:` as a URI scheme and never resolves it, so the
    // prefix is removed first and the bare id goes through the aliases above.
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.slice("node:".length);
    }),
    // The extension's error parser uses `Buffer` without importing it
    // (`cli-error-parser`'s `OutputSource.content` calls
    // `Buffer.concat(content).toString('utf8')`, and `AutoFlushingBuffer` builds
    // on the same object). Webpack's ProvidePlugin gives every module that names
    // `Buffer` a local binding to the polyfill, which is the browser-safe
    // version of that dependency. Installing it on `globalThis` instead was
    // measured to blank the editor: the IDE's own code reads the global too.
    new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
  ],
  module: {
    rules: [
      {
        // The client adapter is ESM and is reached from the CommonJS services.
        test: /\.mjs$/,
        type: "javascript/auto",
      },
    ],
  },
  optimization: { minimize: false },
  stats: { errors: true, warnings: true, modules: false, errorDetails: true },
};
