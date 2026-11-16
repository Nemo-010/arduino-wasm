// Theia's `EnvVariablesServer`, answered from the page instead of from a Node
// process. The paths are the ones `web/app.js` already gives the CLI: the
// filesystem shim's root is `/home/arduino`, the config directory is where
// arduino-cli keeps `arduino15`, and the temporary directory is `/tmp`.
//
// Anything that asks for a variable gets the value the page set, so a setting
// that reads `process.env` and a setting that reads this server agree.

const HOME = "/home/arduino";
const CONFIG = HOME + "/.arduino15";

function fileUri(path) {
  return "file://" + path;
}

function variables() {
  const env = (globalThis.process && globalThis.process.env) || {};
  return Object.keys(env).map((key) => ({ key, value: env[key] }));
}

class EnvVariablesServer {
  async getExecPath() {
    return "/bin";
  }

  async getVariables() {
    return variables();
  }

  async getValue(key) {
    return variables().find((variable) => variable.key === key);
  }

  async getConfigDirUri() {
    return fileUri(CONFIG);
  }

  async getHomeDirUri() {
    return fileUri(HOME);
  }

  async getDrives() {
    return [fileUri("/")];
  }
}

module.exports = { EnvVariablesServer, HOME, CONFIG };
