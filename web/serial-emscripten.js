// Generic serial bridge for Emscripten-built upload tools.
//
// A tool built with scripts/serial-shim.c wraps read() so device reads call
// globalThis.__arduinoSerialRead(fd, pointer, count) and suspend until the
// promise resolves. This module installs that callback for one tool instance
// and registers the WebSerial port as /dev/tty* nodes in the tool's own
// Emscripten filesystem. No tool-specific JavaScript is involved: the tool's
// platform recipe decides what to write and read.

import { createSerialDevices } from "./serial-device.js";

let nextDevice = 64;

export function installEmscriptenSerial(instance, port) {
  const devices = createSerialDevices(port);
  const byFd = new Map();
  globalThis.__arduinoSerialReads = 0;
  for (const [path, source] of devices) {
    const device = nextDevice++;
    instance.FS.registerDevice(device, {
      open(stream) {
        byFd.set(stream.fd, source);
        source.open && source.open();
      },
      close(stream) {
        byFd.delete(stream.fd);
        source.close && source.close();
      },
      llseek() { throw new instance.FS.ErrnoError(70); },
    });
    // Emscripten's TTY layer already owns some /dev/tty* names. Replace its
    // node with ours so the tool's plain open() reaches WebSerial.
    if (instance.FS.analyzePath(path).exists) instance.FS.unlink(path);
    instance.FS.mkdev(path, 0o666, device);
  }

  // Called from the C shim inside EM_ASYNC_JS, so a Promise is safe here: the
  // wasm caller is suspended until it resolves.
  globalThis.__arduinoSerialRead = async (fd, pointer, count) => {
    const source = byFd.get(fd);
    if (!source) throw new Error("no serial device open on fd " + fd);
    const heap = instance.HEAPU8;
    const view = new Uint8Array(heap.buffer, heap.byteOffset + pointer, count);
    globalThis.__arduinoSerialReads += 1;
    return source.read(view, 0, count);
  };
  return { paths: [...devices.keys()] };
}
