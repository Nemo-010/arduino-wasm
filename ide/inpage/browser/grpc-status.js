// What the extension needs from `@grpc/grpc-js` once the network is gone.
//
// `service-error.js` uses two things: `status`, to test a code against
// `NOT_FOUND`, and `Metadata`, to recognise a gRPC error. Both are pure data,
// and the numbers below are copied from the installed package's
// `build/src/constants.d.ts`, which is the same enum the desktop app links
// against. An error in the page carries `code` and `metadata` in the same shape,
// so the recognition still works; what does not exist is a channel to carry it.
const status = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};

class Metadata {
  constructor() {
    this.values = new Map();
  }

  set(key, value) {
    this.values.set(String(key).toLowerCase(), [].concat(value));
  }

  get(key) {
    return this.values.get(String(key).toLowerCase()) || [];
  }

  add(key, value) {
    const current = this.get(key);
    current.push(value);
    this.values.set(String(key).toLowerCase(), current);
    return this;
  }

  clone() {
    const copy = new Metadata();
    for (const [key, value] of this.values) {
      copy.values.set(key, value.slice());
    }
    return copy;
  }

  toObject() {
    const object = {};
    for (const [key, value] of this.values) {
      object[key] = value.length === 1 ? value[0] : value;
    }
    return object;
  }
}

module.exports = { status, Metadata, Status: status };
