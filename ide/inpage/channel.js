'use strict';

// The transport half of the in-page backend: a pair of channels in the same
// page, and a ConnectionSource that hands Theia's client end its half.

const { Emitter } = require('@theia/core/lib/common/event');
const { Disposable } = require('@theia/core/lib/common/disposable');
const { ForwardingChannel } = require('@theia/core/lib/common/message-rpc/channel');
const {
  Uint8ArrayReadBuffer,
  Uint8ArrayWriteBuffer,
} = require('@theia/core/lib/common/message-rpc/uint8-array-message-buffer');

/**
 * One end of an in-memory channel pair. `getWriteBuffer()` hands out a fresh
 * buffer per message, exactly as the websocket source does, and the committed
 * bytes are delivered to the peer's message event.
 */
class LoopbackChannel extends ForwardingChannel {
  constructor() {
    super('any', () => undefined, () => this.createWriteBuffer());
    this.peer = undefined;
  }

  createWriteBuffer() {
    const buffer = new Uint8ArrayWriteBuffer();
    buffer.onCommit(bytes => {
      // `commit()` fires synchronously while the multiplexer is mid-write;
      // delivering the peer's frames from a microtask keeps the two state
      // machines from re-entering each other.
      const copy = new Uint8Array(bytes);
      queueMicrotask(() => {
        this.peer.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(copy));
      });
    });
    return buffer;
  }
}

/**
 * A ConnectionSource that opens one in-memory pair and replays the client end to
 * every listener. Theia creates its ServiceConnectionProvider lazily, so a
 * source that fired only once would be missed by a provider built afterwards.
 */
class InPageConnectionSource {
  constructor() {
    this.emitter = new Emitter();
    this.channel = undefined;
  }

  get onConnectionDidOpen() {
    return (listener, thisArg, disposables) => {
      if (this.channel) {
        listener.call(thisArg, this.channel);
        return Disposable.NULL;
      }
      return this.emitter.event(listener, thisArg, disposables);
    };
  }

  open(onServerChannel) {
    if (this.channel) {
      return;
    }
    const client = new LoopbackChannel();
    const server = new LoopbackChannel();
    client.peer = server;
    server.peer = client;
    this.channel = client;
    onServerChannel(server);
    this.emitter.fire(client);
  }
}

module.exports = { LoopbackChannel, InPageConnectionSource };
