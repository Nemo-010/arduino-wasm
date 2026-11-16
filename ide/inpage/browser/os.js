// A browser has no operating system, and the page's filesystem is POSIX. These
// are the answers a page can honestly give; the services use them for path
// separators and for the home directory.
const os = {
  EOL: "\n",
  platform: () => "linux",
  arch: () => "wasm",
  type: () => "Linux",
  release: () => "0.0.0",
  version: () => "",
  homedir: () => (globalThis.process && globalThis.process.env && globalThis.process.env.HOME) || "/home/arduino",
  tmpdir: () => (globalThis.process && globalThis.process.env && globalThis.process.env.TMPDIR) || "/tmp",
  hostname: () => "arduino-wasm",
  cpus: () => [],
  totalmem: () => 0,
  freemem: () => 0,
  uptime: () => 0,
  loadavg: () => [0, 0, 0],
  userInfo: () => ({ username: "arduino", homedir: os.homedir(), shell: "/bin/sh", uid: 0, gid: 0 }),
  constants: {},
};

module.exports = os;
module.exports.default = os;
