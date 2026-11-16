// A drop-in for `./exec-util`.
//
// The desktop IDE shells out to the `arduino-cli` binary for three commands --
// `config dump --json`, `config get directories.<key> --json` and `config init
// --dest-dir <dir>` -- because the CLI owns the configuration format. In the
// page there is no process to spawn, but the CLI is right there as the wasm
// module, so each of those three commands is answered by the RPC the CLI's own
// command implementation calls:
//
//   dump --json        -> ConfigurationSave{settingsFormat: "json"}, wrapped in
//                         {"config": ...} exactly as `dumpResult` wraps it
//   get <key> --json   -> SettingsGetValue{key}, whose encodedValue is already
//                         the JSON the CLI prints
//   init --dest-dir    -> ConfigurationSave{settingsFormat: "yaml"}, written to
//                         <dir>/arduino-cli.yaml, which is what `config init`
//                         produces
//
// Everything else is refused by name: a page that quietly returned "" for an
// unknown command would look like a working CLI and silently break whichever
// caller asked.

const path = require("path");
const fs = require("./fs.js");
const { createArduinoCoreServiceClient } = require("./core-client");
const settings = require("arduino-extension/node/cli-protocol/cc/arduino/cli/commands/v1/settings_pb");

// `ConfigServiceImpl` writes the CLI's configuration file at exactly this name
// inside the directory it passes to `config init`.
const CLI_CONFIG = "arduino-cli.yaml";

function client() {
  const bridge = globalThis.arduinoCLI;
  if (!bridge || typeof bridge.callBinary !== "function") {
    throw new Error("arduinoCLI.callBinary is not available: start the wasm CLI before the IDE's services run");
  }
  return createArduinoCoreServiceClient({ port: 1 });
}

function unary(core, name, request) {
  return new Promise((resolve, reject) => {
    core[name](request, (error, response) => (error ? reject(error) : resolve(response)));
  });
}

async function encodedSettings(format) {
  const core = client();
  try {
    const request = new settings.ConfigurationSaveRequest();
    request.setSettingsFormat(format);
    const response = await unary(core, "configurationSave", request);
    return response.getEncodedSettings();
  } finally {
    core.close();
  }
}

async function settingsValue(key) {
  const core = client();
  try {
    const request = new settings.SettingsGetValueRequest();
    request.setKey(key);
    const response = await unary(core, "settingsGetValue", request);
    return response.getEncodedValue();
  } finally {
    core.close();
  }
}

function refuse(command, args) {
  return new Error(
    "spawnCommand: the page cannot run `" +
      [command, ...args].join(" ") +
      "`: no process can be spawned here, and only arduino-cli's `config` subcommands are answered in-process",
  );
}

async function spawnCommand(command, args, onError = (error) => console.log(error)) {
  const fail = (error) => {
    onError(error);
    throw error;
  };
  if (!Array.isArray(args) || args[0] !== "config") {
    return fail(refuse(command, args || []));
  }
  const [, subcommand, ...rest] = args;

  if (subcommand === "dump") {
    // `config dump --json` prints `{"config": <settings>}`; the IDE reads
    // `.config` and expects the CLI's own object shape.
    const encoded = await encodedSettings("json").catch(fail);
    const parsed = JSON.parse(encoded);
    return JSON.stringify({ config: parsed });
  }

  if (subcommand === "get") {
    const key = rest[0];
    if (!key) return fail(new Error("spawnCommand: `config get` needs a key"));
    return settingsValue(key).catch(fail);
  }

  if (subcommand === "init") {
    const at = rest.indexOf("--dest-dir");
    const dir = at >= 0 ? rest[at + 1] : undefined;
    if (!dir) return fail(new Error("spawnCommand: `config init` needs --dest-dir"));
    const yaml = await encodedSettings("yaml").catch(fail);
    await fs.promises.writeFile(path.join(dir, CLI_CONFIG), yaml, { encoding: "utf8" }).catch(fail);
    return "";
  }

  return fail(refuse(command, args));
}

module.exports = { spawnCommand };
