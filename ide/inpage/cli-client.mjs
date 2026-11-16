// The IDE's generated gRPC client, minus the network.
//
// arduino-ide's node services are written against the client that
// `@grpc/grpc-js` builds from the generated service definition: unary calls take
// `(request, callback)`, streaming calls return an object you listen to for
// `data`, `error`, `end` and `status`. This module builds that same surface from
// that same definition, so the real services run unchanged while the actual work
// happens in the wasm CLI behind `callBinary`.
//
// The wire is protobuf binary in both directions: the request is serialized by
// the generated message class and the reply is deserialized by the generated
// response class. Nothing is translated through JSON, so a client sees exactly
// the messages the desktop IDE's client would give it.

import { EventEmitter } from "node:events";

// The namespace property that holds the generated service definition.
export const CORE_SERVICE_NAME = "cc.arduino.cli.commands.v1.ArduinoCoreService";

function goMethodName(definition) {
  const path = definition.path;
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function decodeBase64(text) {
  if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(text, "base64"));
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined") return Buffer.from(view).toString("base64");
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

// A gRPC error is not a bare Error. `service-error.js` recognises one by
// `code`, `details` and `metadata instanceof Metadata`, and only then does the
// IDE parse a compile failure into compiler errors instead of reporting an
// unexpected error. The class has to come from the caller, because the page
// aliases `@grpc/grpc-js` to a shim while a Node test has the real package.
// Without it the status is still honest -- it just lacks the marker.
function statusObject(code, details, Metadata) {
  return { code, details, message: details, metadata: Metadata ? new Metadata() : undefined };
}

function statusError(code, details, Metadata) {
  const error = new Error(details);
  error.code = code;
  error.details = details;
  if (Metadata) error.metadata = new Metadata();
  return error;
}

function statusOf(events, Metadata) {
  const failure = [...events].reverse().find((event) => event.type === "error");
  if (!failure) return statusObject(0, "OK", Metadata);
  // The bridge carries the code the CLI's error declares, and the extension
  // branches on it: a NotFound from LoadSketch is "this is not a sketch" and is
  // handled, while an unknown failure is a bug worth showing. A Go error with
  // no status of its own is UNKNOWN, which is what grpc-go would have said.
  const code = typeof failure.code === "number" ? failure.code : 2;
  return statusObject(code, failure.message, Metadata);
}

/**
 * Build the client surface the IDE's services expect.
 *
 * @param {object} options
 * @param {object} options.service the generated service definition, e.g.
 *   commands_grpc_pb[CORE_SERVICE_NAME]
 * @param {(method: string, requestBase64: string) => Promise<object[]>} options.callBinary
 *   the transport: it resolves with the bridge's event objects
 * @param {(event: {type: string, message?: string}) => void} [options.onEvent]
 *   optional observer for every event, used by the page's log
 */
export function createArduinoCoreClient({ service, callBinary, onEvent, Metadata }) {
  const client = {
    close() {},
    getChannel() {
      return { getTarget: () => "arduino-cli-wasm", close() {} };
    },
  };

  for (const [name, definition] of Object.entries(service)) {
    if (!definition || typeof definition.path !== "string") continue;
    if (definition.requestStream) {
      // No arduino-cli RPC takes a request stream. Refuse loudly rather than
      // hand the caller a method that silently does nothing.
      client[name] = () => {
        throw new Error(name + ": request-streaming RPCs are not supported");
      };
      continue;
    }

    const goName = goMethodName(definition);
    const Response = definition.responseType;

    if (definition.responseStream) {
      client[name] = (request) => {
        const stream = new EventEmitter();
        const bytes = request.serializeBinary();
        const events = [];
        let settled = false;
        // Events are delivered as the CLI produces them, so a platform install
        // reports progress while it runs instead of when it ends. The promise
        // is only consulted for the stream's final status.
        const observe = (event) => {
          events.push(event);
          if (onEvent) onEvent(event);
          if (settled) return;
          if (event.type === "error" || event.type === "done") return;
          if (typeof event.binary === "string") {
            stream.emit("data", Response.deserializeBinary(decodeBase64(event.binary)));
          }
        };
        // A stream ends once. Cancelling is one of the ways it ends, and the
        // extension's BoardDiscovery waits for exactly that signal: its
        // `stop()` disposes the watcher and resolves when the stream reports
        // CANCELLED. A no-op cancel left that promise to time out after 10 s.
        let cancelCall = null;
        const end = (status) => {
          if (settled) return;
          settled = true;
          stream.emit("status", status);
          stream.emit("end");
        };
        const call = callBinary(goName, encodeBase64(bytes), observe);
        if (call && typeof call.cancel === "function") cancelCall = () => call.cancel();
        call
          .then(() => {
            const status = statusOf(events, Metadata);
            if (status.code !== 0) {
              stream.emit("error", statusError(status.code, status.details, Metadata));
            }
            end(status);
          })
          .catch((error) => {
            // The transport rejects with the CLI's message; the events carry it
            // too, and they are what the status is built from.
            const status = statusOf(events, Metadata);
            const code = status.code !== 0 ? status.code : 2;
            const details = status.code !== 0 ? status.details : error.message;
            stream.emit("error", statusError(code, details, Metadata));
            end(statusObject(code, details, Metadata));
          });
        stream.cancel = () => {
          if (settled) return;
          if (cancelCall) cancelCall();
          // grpc-js reports a cancelled call as status CANCELLED, then ends.
          stream.emit("error", statusError(1, "Cancelled", Metadata));
          end(statusObject(1, "Cancelled", Metadata));
        };
        return stream;
      };
      continue;
    }

    // Unary. grpc-js accepts (request, metadata, options, callback) with the
    // middle arguments elided; take whichever argument is a function.
    client[name] = (...args) => {
      const callback = args.find((arg) => typeof arg === "function");
      const request = args[0];
      if (!callback) return undefined;
      const bytes = request.serializeBinary();
      const events = [];
      const observe = (event) => {
        events.push(event);
        if (onEvent) onEvent(event);
      };
      callBinary(goName, encodeBase64(bytes), observe)
        .then((resolved) => {
          // The transport resolves with the events it dispatched, and a
          // transport that reports only through the observer still works
          // because the same events are collected here. Both shapes are real:
          // the harness and the page's bridge resolve with an array.
          const seen = Array.isArray(resolved) && resolved.length ? resolved : events;
          const failure = seen.find((event) => event.type === "error");
          if (failure) {
            // The code is the CLI's own: the extension tests it (NOT_FOUND
            // means "not a sketch", NOT_FOUND from upload means "no port"),
            // and a status that says UNKNOWN for everything erases that.
            const status = statusOf(seen, Metadata);
            callback(statusError(status.code, status.details, Metadata));
            return;
          }
          const result = [...seen].reverse().find((event) => typeof event.binary === "string");
          if (!result) {
            callback(statusError(2, goName + ": the CLI reported no response", Metadata));
            return;
          }
          callback(null, Response.deserializeBinary(decodeBase64(result.binary)), statusObject(0, "OK", Metadata));
        })
        .catch((error) => {
          // Two transports are real. The page's bridge resolves with the events
          // it dispatched; a Node-side driver rejects on the error event and
          // attaches them as `error.events`. Handing the raw transport error
          // back would lose the code, which is the half the extension reads.
          const seen = Array.isArray(error.events) && error.events.length ? error.events : events;
          const status = statusOf(seen, Metadata);
          const code = status.code !== 0 ? status.code : 2;
          const details = status.code !== 0 ? status.details : error.message;
          callback(statusError(code, details, Metadata));
        });
      return undefined;
    };
  }

  return client;
}
