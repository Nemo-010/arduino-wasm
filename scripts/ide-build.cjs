// `theia build`, with its Electron runtime preparation skipped.
//
// Theia's build prepares an Electron *runtime* before it generates anything:
// prepare() -> prepareElectron() reads node_modules/electron/dist/version, then
// downloads Electron's ffmpeg library and installs it into that dist. None of
// that is part of what this project builds. The page loads bundle.js in a
// browser; the Electron binary is never run, never packed, never shipped. The
// step is also why CI failed: node_modules/electron/dist exists only after
// Electron's own postinstall runs, and this build installs dependencies with
// --ignore-scripts.
//
// Declaring a browser target is not the way out. Five of the app's browser
// contributions inject WindowServiceExt, and only its electron-browser window
// module binds it, so a browser-target frontend dies on the splash with
// "No matching bindings found for serviceIdentifier: Symbol(WindowServiceExt)".
// The target stays electron. Only prepare() is replaced, and it is replaced on
// the prototype the CLI itself calls, so generate(), copy() and the webpack
// pass are upstream's own code paths, unchanged.
//
// Run: node scripts/ide-build.cjs <electron-app directory>
// Exit: 0 built, 2 no argument, 3 or 4 upstream changed the shape this relies on.

const path = require("path");

const app = process.argv[2];
if (!app) {
  console.error("usage: node ide-build.cjs <electron-app>");
  process.exit(2);
}

// The CLI resolves these from its own location. Asserting that both resolve to
// the same file is the check that the prototype patched here is the prototype
// the CLI will call: two copies of the package in one tree would silently make
// this a no-op.
const managerPath = require.resolve("@theia/application-manager", { paths: [app] });
const cliDir = path.dirname(require.resolve("@theia/cli/package.json", { paths: [app] }));
const managerFromCli = require.resolve("@theia/application-manager", { paths: [cliDir] });
if (managerPath !== managerFromCli) {
  console.error("error: two copies of @theia/application-manager\n  " + managerPath + "\n  " + managerFromCli);
  process.exit(4);
}

const { ApplicationPackageManager } = require(managerPath);
if (typeof ApplicationPackageManager.prototype.prepare !== "function") {
  console.error("error: ApplicationPackageManager.prototype.prepare is not a function; "
    + "upstream changed the shape this build relies on");
  process.exit(3);
}
ApplicationPackageManager.prototype.prepare = async function () {
  console.log("  => skipped Electron runtime preparation (this build produces a web page)");
};

// The command line is parsed by yargs' singleton, which reads process.argv. That
// is how `build` reaches the handler; the app-target sub-parse is a second,
// argv-less parser and is why --app-target on the real CLI does nothing.
process.argv = [process.argv[0], "theia", "build"];
require(path.join(cliDir, "lib", "theia"));
