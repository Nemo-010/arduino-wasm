// The generic upload path: arduino-cli builds the board's declared upload
// command and hands it to the same exec seam a compile uses. This test proves
// the bridge reaches that seam with the real command line, without any board-
// specific code in the wasm build.
//
// The fixture platform declares `upload.tool.serial` and an upload pattern;
// the CLI expands it from the board's own properties. The runner answers the
// command, so no host tool or device is involved. What this test does NOT do
// is perform a flash -- that is the driver behind the exec seam, and it needs
// a WebUSB/WebSerial device. It proves the generic route to that driver.
//
// Run: node test/upload.mjs
// Exit: 0 all checks passed, 1 a check failed.

import { startCLI } from "./harness.mjs";
import { fixtureFetch, FIXTURE_ORIGIN } from "./fixture-fetch.mjs";

const realProcess = process;
let failures = 0;
function check(condition, message, detail) {
  console.log((condition ? "  ok  " : "FAIL  ") + message + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!condition) failures += 1;
}

const execs = [];
globalThis.arduinoExec = (request, callback) => {
  execs.push(request);
  callback({ code: 0, stdout: "", stderr: "" });
};

const cli = await startCLI({
  fetch: fixtureFetch([]),
  env: {
    ARDUINO_DEFAULT_INDEX_URL: FIXTURE_ORIGIN + "/package_fixture_index.json",
    ARDUINO_LIBRARIES_INDEX_URL: FIXTURE_ORIGIN + "/library_index.json",
    ARDUINO_TOOL_HOST_OS: "linux",
    ARDUINO_TOOL_HOST_ARCH: "amd64",
  },
  stderr: () => {},
});

const settings = [
  "directories:",
  "  data: /home/arduino/.arduino15",
  "  downloads: /home/arduino/.arduino15/staging",
  "  user: /home/arduino/Arduino",
].join("\n");
await cli.call("ConfigurationOpen", { encoded_settings: settings, settings_format: "yaml" });
const created = await cli.call("Create", {});
const instance = created.find((event) => event.type === "result").data.instance;
await cli.call("Init", { instance });
await cli.call("PlatformInstall", {
  instance,
  platform_package: "testpkg",
  architecture: "avr",
  version: "1.0.0",
  skip_post_install: true,
}, { timeoutMs: 180000 });

globalThis.fs.mkdirSync("/home/arduino/Arduino/sketch", { recursive: true });
globalThis.fs.writeFileSync("/home/arduino/Arduino/sketch/sketch.ino", "void setup() {}\nvoid loop() {}\n");
const build = "/home/arduino/.cache/arduino/sketches/35B2BECCD979BE3EAA6425E491999E6A";
globalThis.fs.mkdirSync(build, { recursive: true });
globalThis.fs.writeFileSync(build + "/sketch.ino.hex", ":00000001FF\n");

let events = null;
let error = null;
try {
  events = await cli.call("Upload", {
    instance,
    sketch_path: "/home/arduino/Arduino/sketch",
    fqbn: "testpkg:avr:testboard",
    port: { address: "/dev/ttyACM0", label: "dummy", protocol: "serial" },
    verbose: true,
    verify: false,
    user_fields: {},
  }, { timeoutMs: 60000 });
} catch (thrown) {
  error = String(thrown);
}
check(error === null, "the Upload RPC reaches the CLI's own service", error);
const kinds = (events || []).map((event) => event.type);
check(kinds.includes("done"), "the upload stream ends", JSON.stringify(kinds));
check(execs.length === 1, "one tool command was handed to the exec seam", JSON.stringify(execs));
if (execs.length) {
  const argv = execs[0].args || [];
  check(argv.length > 1, "the command has the tool and its arguments", JSON.stringify(argv));
  const command = argv.join(" ");
  check(/testtool/.test(command), "the tool is the one the platform declares", command);
  check(/-Uflash:w:.*\.hex:i/.test(command), "the CLI built the flash recipe from platform.txt", command);
  check(command.includes(build + "/sketch.ino.hex"), "the hex is the compiled sketch", command);
  check(Array.isArray(execs[0].env), "the tool inherits the CLI's environment", JSON.stringify(execs[0].env).slice(0, 120));
}

realProcess.exitCode = failures === 0 ? 0 : 1;
console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " failed");
