// Minimal gzip + tar reader.
//
// The AVR sysroot ships as a .tar.gz (~900 KB) to keep the repository small and
// to keep the licence boundaries obvious: it is avr-libc and libgcc, unpacked
// unchanged. The page has to open it, and the alternative is a dependency on a
// tar library, which this project does without.
//
// Handles what GNU tar produces for these archives: ustar headers, the GNU
// long-name entry ("L") and the pax extended header ("x", ignored as a whole).

export async function gunzip(bytes) {
  if (typeof DecompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error("this runtime has no DecompressionStream, so it cannot read .tar.gz");
}

function text(bytes) {
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function octal(bytes) {
  const value = text(bytes).trim();
  return value === "" ? 0 : parseInt(value, 8);
}

// Returns [{ name, type, data }] where type is "file" or "dir". Paths are
// relative, posix, with no leading "./".
export function untar(archive) {
  const entries = [];
  const block = 512;
  let offset = 0;
  let longName = null;
  let longLink = null;

  while (offset + block <= archive.length) {
    const header = archive.subarray(offset, offset + block);
    // Two zero blocks end the archive; one is enough to stop reading.
    if (header.every((byte) => byte === 0)) break;

    const name = text(header.subarray(0, 100));
    const mode = octal(header.subarray(100, 108));
    const size = octal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const linkname = text(header.subarray(157, 257));
    const prefix = text(header.subarray(345, 500));
    const body = archive.subarray(offset + block, offset + block + size);
    const padded = offset + block + Math.ceil(size / block) * block;

    if (typeflag === "L") {
      longName = text(body);
      offset = padded;
      continue;
    }
    if (typeflag === "K") {
      longLink = text(body);
      offset = padded;
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      // pax headers describe the next entry; the size and name we need are in
      // the ustar header for every archive this project ships.
      offset = padded;
      continue;
    }

    let fullName = prefix ? prefix + "/" + name : name;
    if (longName !== null) {
      fullName = longName;
      longName = null;
    }
    let fullLink = linkname;
    if (longLink !== null) {
      fullLink = longLink;
      longLink = null;
    }
    fullName = fullName.replace(/^\.\//, "").replace(/\/+$/, "");
    if (fullName !== "") {
      if (typeflag === "5") {
        entries.push({ name: fullName, type: "dir", mode });
      } else if (typeflag === "0" || typeflag === "7" || typeflag === "\0") {
        entries.push({ name: fullName, type: "file", data: body.slice(), mode });
      } else if (typeflag === "2") {
        entries.push({ name: fullName, type: "link", target: fullLink, mode });
      }
      // Other types (devices, fifos) do not appear in these archives.
    }
    offset = padded;
  }

  return entries;
}

// Convenience for the sysroot: gunzip then untar.
export async function readTarGz(bytes) {
  return untar(await gunzip(bytes));
}
