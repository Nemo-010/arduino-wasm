// Reads a zip back through its central directory.
//
// A reader that only understands what this project's own writer produces would
// prove nothing, so it walks the central directory and asserts the compression
// method rather than assuming where the bytes are. Shared by the port's test
// and the build's test, because two copies of this would drift.

export function unzip(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = data.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("zip: no end of central directory record");
  const count = view.getUint16(end + 10, true);
  const total = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("zip: central record " + index + " is not a header");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(data.slice(at + 46, at + 46 + nameLength));
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const start = local + 30 + localNameLength + localExtraLength;
    entries.set(name, { method, data: data.slice(start, start + size) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at - view.getUint32(end + 16, true) !== total) throw new Error("zip: central directory size disagrees");
  return entries;
}
