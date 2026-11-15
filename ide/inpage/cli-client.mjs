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

function statusOf(events) {
  const error = events.find((event) => event.type === "error");
  if (!error) return { code: 0, details: "OK", message: "OK", metadata: {} };
  return { code: 2, details: error.message, message: error.message, metadata: {} };
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
export function createArduinoCoreClient({ service, callBinary, onEvent }) {
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
        callBinary(goName, encodeBase64(bytes), onEvent)
          .then((events) => {
            for (const event of events) {
              if (event.type === "error" || event.type === "done") continue;
              if (typeof event.binary === "string") {
                stream.emit("data", Response.deserializeBinary(decodeBase64(event.binary)));
              }
            }
            const status = statusOf(events);
            stream.emit("status", status);
            if (status.code !== 0) stream.emit("error", new Error(status.details));
            stream.emit("end");
          })
          .catch((error) => {
            stream.emit("error", error);
            stream.emit("end");
          });
        stream.cancel = () => {};
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
      callBinary(goName, encodeBase64(bytes), onEvent)
        .then((events) => {
          const failure = events.find((event) => event.type === "error");
          if (failure) {
            callback(new Error(failure.message));
            return;
          }
          const result = [...events].reverse().find((event) => typeof event.binary === "string");
          if (!result) {
            callback(new Error(goName + ": the CLI reported no response"));
            return;
          }
          callback(null, Response.deserializeBinary(decodeBase64(result.binary)), {
            code: 0,
            details: "OK",
            metadata: {},
          });
        })
        .catch((error) => callback(error));
      return undefined;
    };
  }

  return client;
}
