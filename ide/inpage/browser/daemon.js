// The extension's daemon spawns `arduino-cli daemon --port 0` and reports the
// port it printed. In the page there is no process to spawn: the CLI is already
// the wasm module, and the client the services use is backed by it directly.
//
// This keeps the contract the rest of the backend reads -- a port, an
// onDaemonStarted event, a stop that does nothing -- so `CoreClientProvider`
// runs its own create/init/index-recovery path unchanged. That path is the
// IDE's real answer to a missing package index, and keeping it is the point:
// the page should get the IDE's behaviour, not a simplified copy of it.

const { Emitter } = require("@theia/core/lib/common/event");

// The port is never opened. It names the daemon the client is bound to, and the
// client ignores it.
const VIRTUAL_PORT = 1;

class ArduinoDaemonImpl {
  constructor(logger) {
    this.logger = logger || {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      log: () => {},
      child: () => this.logger,
    };
    this.onDaemonStartedEmitter = new Emitter();
    this.onDaemonStoppedEmitter = new Emitter();
    this.onDaemonOutputEmitter = new Emitter();
    this.running = false;
  }

  onStart() {
    this.start();
  }

  // The desktop daemon reports the path of the `arduino-cli` executable it
  // spawns, and `ConfigServiceImpl` passes that path straight back to
  // `spawnCommand`. Here the CLI is the wasm module rather than a file, so the
  // name identifies it without pretending a program exists on disk.
  getExecPath() {
    return "arduino-cli.wasm";
  }

  async getPort() {
    return this.start();
  }

  async tryGetPort() {
    return this.running ? VIRTUAL_PORT : undefined;
  }

  async start() {
    if (!this.running) {
      this.running = true;
      this.onData("The CLI runs in the page as a WebAssembly module.");
      this.onDaemonStartedEmitter.fire(VIRTUAL_PORT);
    }
    return VIRTUAL_PORT;
  }

  async stop() {
    if (this.running) {
      this.running = false;
      this.onDaemonStoppedEmitter.fire();
    }
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  get onDaemonStarted() {
    return this.onDaemonStartedEmitter.event;
  }

  get onDaemonStopped() {
    return this.onDaemonStoppedEmitter.event;
  }

  get onDaemonOutput() {
    return this.onDaemonOutputEmitter.event;
  }

  onData(message) {
    this.onDaemonOutputEmitter.fire({ message: String(message), level: "info" });
  }

  onError(error) {
    this.onDaemonOutputEmitter.fire({
      message: error && error.message ? error.message : String(error),
      level: "error",
    });
  }

  dispose() {
    this.onDaemonStartedEmitter.dispose();
    this.onDaemonStoppedEmitter.dispose();
    this.onDaemonOutputEmitter.dispose();
  }
}

module.exports = { ArduinoDaemonImpl };
