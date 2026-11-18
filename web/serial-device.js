// One serial device for every upload tool compiled to wasm.
//
// A native tool opens `/dev/ttyACM0` with plain POSIX calls. Those calls land
// in nodefs, which forwards read/write/ioctl here, and this module forwards
// them to the WebSerial port the user picked. No tool needs a JavaScript
// flasher, so a core that declares a new upload tool only needs a wasm build
// of that tool -- not new code in this page.

const PATHS = ["/dev/ttyACM0", "/dev/ttyUSB0", "/dev/ttyS0", "/dev/cu.usbmodem", "/dev/tty"];

export function createSerialDevices(port) {
  if (!port) return new Map();
  const devices = new Map();
  let reader = null;
  let writer = null;
  const pending = [];

  async function ensure() {
    if (!port.opened) await port.open({ baudRate: 115200 });
    if (!reader && port.readable) reader = port.readable.getReader();
    if (!writer && port.writable) writer = port.writable.getWriter();
  }

  async function read(buffer, offset, length) {
    await ensure();
    const deadline = Date.now() + 5000;
    while (pending.length === 0 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) throw new Error("serial device closed");
      if (value) pending.push(...value);
    }
    const count = Math.min(length, pending.length);
    for (let i = 0; i < count; i += 1) buffer[offset + i] = pending.shift();
    return count;
  }

  async function write(buffer, offset, length) {
    await ensure();
    await writer.write(buffer.subarray(offset, offset + length));
    return length;
  }

  async function close() {
    if (reader) reader.releaseLock();
    if (writer) writer.releaseLock();
    reader = null;
    writer = null;
    if (port.opened) await port.close();
  }

  for (const path of PATHS) {
    devices.set(path, {
      open: ensure,
      read,
      write,
      close,
      // TCGETS: return a minimal termios structure; TCSETS is accepted and
      // ignored because WebSerial owns the baud rate and framing.
      ioctl: async (request) => (request === 0x5401 || request === 0x5402 ? 0 : -1),
    });
  }
  return devices;
}
