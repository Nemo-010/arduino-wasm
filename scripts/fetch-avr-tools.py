#!/usr/bin/env python3
"""Vendor the wasm-hosted AVR toolchain into web/tools/avr/.

The toolchain is not built here. startabit/avr-gcc-wasm publishes it as release
assets: GCC 7.3.0 with Arduino's atmel patches, binutils 2.42, both compiled to
wasm by Emscripten, plus a sysroot that Arduino's own avr-gcc precompiled. This
script downloads those bytes and checks them against the hashes pinned below,
which come from the release's SHA256SUMS file at the tag.

Pinning the hashes in the source means a replaced SHA256SUMS on the release
cannot make a different binary pass.

The .wasm files stay gzipped in the tree: the page decompresses them with the
browser's own DecompressionStream, so the repository carries 6.2 MB instead of
16 MB.

    python3 scripts/fetch-avr-tools.py [--force]
"""

import argparse
import hashlib
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET = os.path.join(ROOT, "web", "tools", "avr")

RELEASE = "https://github.com/startabit/avr-gcc-wasm/releases/download/v1"

# name: sha256, exactly as the release's SHA256SUMS lists them.
ASSETS = {
    "cc1plus.wasm.gz": "7e36e95f26f3934a4dc86b9d984de1e5e89df80f794347d176d6dff646eb554f",
    "as.wasm.gz": "8fd59073e4e861bca4016412a944dd6049c957b91deb2cea652b578d45f0242d",
    "ld.wasm.gz": "6ae23384697ce27858d71f8f3eccab6607ff08b5e688f90e81e918a44747ff9b",
    "objcopy.wasm.gz": "e9b8a977a9f297225c6b512da1b63d29150dc0593d4cf185fe3576e115fe1083",
    "sysroot.tar.gz": "51c5d54ee437f1c0a78032c4f122cae0184a9ebf478312e46f175b2769192c22",
    "cc1plus.mjs": "1d0d11037c051f8af31b0cc20d595be9bb7caf23e7d1d567c60e0e5f7f0ee8b6",
    "as.mjs": "61bbed90ca23c1eb091674a14853e0cef8d2ed6bbfa1b259390210514b603abc",
    "ld.mjs": "52924d1c389bffb3301288e191e65289c002a9c2ef5401e2472c536d077766a7",
    "objcopy.mjs": "8d6bf1179c349a21845201c3750c5d6bae4847293b97b8a4d8894da7d5a1516d",
    "manifest.json": "f81ca6a24609fb96386cf58b9aac1d00393a36526ff5200f6710b8c02d95c69e",
}


def digest(path):
    sha = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            sha.update(block)
    return sha.hexdigest()


def fetch(name, force):
    path = os.path.join(TARGET, name)
    expected = ASSETS[name]
    if os.path.exists(path) and not force:
        actual = digest(path)
        if actual == expected:
            print("ok      " + name + " (already vendored)")
            return True
        print("bad     " + name + " has " + actual + ", removing it")
        os.remove(path)

    url = RELEASE + "/" + name
    print("fetch   " + url)
    request = urllib.request.Request(url, headers={"User-Agent": "arduino-wasm"})
    partial = path + ".part"
    try:
        with urllib.request.urlopen(request, timeout=300) as response, open(partial, "wb") as handle:
            while True:
                block = response.read(1 << 20)
                if not block:
                    break
                handle.write(block)
    except Exception as error:  # noqa: BLE001 - the message is the report
        if os.path.exists(partial):
            os.remove(partial)
        print("FAILED  " + name + ": " + str(error))
        return False

    actual = digest(partial)
    if actual != expected:
        os.remove(partial)
        print("FAILED  " + name + ": sha256 " + actual + " != " + expected)
        return False
    os.replace(partial, path)
    print("ok      " + name + " (" + str(os.path.getsize(path)) + " bytes, sha256 verified)")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="re-download even when the hash matches")
    args = parser.parse_args()

    os.makedirs(TARGET, exist_ok=True)
    failures = [name for name in ASSETS if not fetch(name, args.force)]
    if failures:
        print("missing: " + ", ".join(failures))
        return 1

    # The device table is generated from the same GCC release's avr-mcus.def, so
    # -mmcu=<board> can be translated without a table anybody typed.
    gen = os.path.join(HERE, "gen-avr-mcus.py")
    print("run     " + os.path.relpath(gen, ROOT))
    return os.spawnv(os.P_WAIT, sys.executable, [sys.executable, gen])


if __name__ == "__main__":
    sys.exit(main())
