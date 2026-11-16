// A drop-in for `./arduino-core-service-client`.
//
// The upstream module builds a grpc-js client that dials a spawned daemon's TCP
// port. In the page there is no port and no socket: the same service definition
// is served by the wasm CLI through `arduinoCLI.callBinary`. Everything above
// this seam -- `CoreClientProvider`, the service classes, their streaming and
// unary helpers -- is upstream code running unchanged.

const { createArduinoCoreClient } = require("../cli-client.mjs");
// `service-error.js` recognises a gRPC error by `metadata instanceof Metadata`,
// so the class has to be the one that module sees. It comes from the same
// alias: in the bundle `@grpc/grpc-js` is this directory's `grpc-status.js`, and
// in a Node test it is the real package.
const { Metadata } = require("@grpc/grpc-js");
// The generated service definition, resolved by the bundler to the extension's
// own `commands_grpc_pb.js`. It carries the method paths and message classes and
// imports nothing but protobuf modules.
const definition = require("arduino-core-service-definition");

const CORE_SERVICE_NAME = "cc.arduino.cli.commands.v1.ArduinoCoreService";

// grpc-js's channel options. The page has no channel, so the only thing worth
// keeping is the size limit the desktop app sets: a platform install streams a
// lot of messages, and grpc's 4 MB default is smaller than some replies.
function createDefaultChannelOptions(_appVersion) {
  return {
    "grpc.max_receive_message_length": 512 * 1024 * 1024,
    "grpc.max_send_message_length": 512 * 1024 * 1024,
  };
}

// The bridge's `callBinary` reports through a callback and returns nothing. The
// client above wants a promise, and wants every event as it arrives rather than
// a batch at the end, so this turns one into the other without buffering the
// intermediate events away from the caller.
//
// There is no timeout here on purpose: installing a core takes minutes and a
// timer that fires during a working install would abort it. The bridge always
// ends a call with `done` or `error`.
function bridgeCallBinary(bridge, method, request, onEvent) {
  return new Promise((resolve, reject) => {
    const events = [];
    let settled = false;
    bridge.callBinary(method, request, (raw) => {
      if (settled) return;
      let event;
      try {
        event = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (error) {
        settled = true;
        reject(new Error(method + ": the bridge sent a payload that is not JSON: " + String(raw).slice(0, 120)));
        return;
      }
      events.push(event);
      if (onEvent) onEvent(event);
      if (event.type === "done") {
        settled = true;
        resolve(events);
      } else if (event.type === "error") {
        settled = true;
        const failure = new Error(method + ": " + event.message);
        failure.events = events;
        reject(failure);
      }
    });
  });
}

// The daemon's port is a constant the page never opens. The client is bound to
// the wasm module instead, and `close()` has nothing to close.
function createArduinoCoreServiceClient(_options) {
  const bridge = globalThis.arduinoCLI;
  if (!bridge || typeof bridge.callBinary !== "function") {
    throw new Error(
      "arduinoCLI.callBinary is not available: the wasm CLI must be started before the IDE's services run",
    );
  }
  const client = createArduinoCoreClient({
    service: definition[CORE_SERVICE_NAME],
    callBinary: (method, request, onEvent) => bridgeCallBinary(bridge, method, request, onEvent),
    Metadata,
  });
  return client;
}

module.exports = { CORE_SERVICE_NAME, createDefaultChannelOptions, createArduinoCoreServiceClient };
