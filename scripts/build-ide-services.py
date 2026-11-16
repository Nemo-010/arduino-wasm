#!/usr/bin/env python3
"""Build the browser bundle of arduino-ide's backend services.

`ide/inpage/browser/entry.js` is the page's webpack entry. It imports the
extension's own compiled classes and rewrites only the modules a browser cannot
have, so the bundle is produced by the IDE tree's webpack -- the same version the
Electron app builds with -- and not by a tool this repo adds.

The precondition is a built IDE tree: `scripts/build-ide.py` produces
`build/arduino-ide` with `arduino-ide-extension/lib/` and the extension's
`node_modules`. Without it there is nothing to bundle and nothing to bundle
with, so this script says that by name rather than failing inside webpack.
"""

import argparse
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "ide/inpage/browser/webpack.config.js")


def fail(message):
    sys.exit("build-ide-services: " + message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ide-tree", default=os.path.join(ROOT, "build/arduino-ide"))
    parser.add_argument("--out", default=os.path.join(ROOT, "build/ide-services"))
    parser.add_argument("--log", default=os.path.join(ROOT, "build/ide-services.log"))
    args = parser.parse_args()

    webpack = os.path.join(args.ide_tree, "node_modules/webpack/bin/webpack.js")
    extension = os.path.join(args.ide_tree, "arduino-ide-extension/lib/node")
    for path, what in [(webpack, "webpack"), (extension, "the extension's compiled classes")]:
        if not os.path.exists(path):
            fail(
                "no %s at %s -- run scripts/build-ide.py first; CI does not build the IDE tree, so this "
                "bundle is a local artefact (see README)" % (what, path)
            )

    os.makedirs(args.out, exist_ok=True)
    env = dict(os.environ)
    env["ARDUINO_WASM_REPO"] = ROOT
    env["ARDUINO_IDE_TREE"] = args.ide_tree
    env["ARDUINO_WASM_OUT"] = args.out

    started = time.time()
    with open(args.log, "w") as log:
        # webpack resolves the config's own `require`s relative to the config's
        # directory, and the config resolves the IDE's packages relative to
        # ARDUINO_IDE_TREE. Running from the IDE tree matches the Electron app.
        code = subprocess.call(["node", webpack, "--config", CONFIG], cwd=args.ide_tree, env=env, stdout=log, stderr=subprocess.STDOUT)
    elapsed = time.time() - started

    with open(args.log) as handle:
        text = handle.read()
    if code != 0:
        print(text[-4000:])
        fail("webpack exited %d after %.1f s; full log in %s" % (code, elapsed, args.log))

    bundle = os.path.join(args.out, "services.js")
    if not os.path.exists(bundle):
        fail("webpack exited 0 but wrote no %s; log in %s" % (bundle, args.log))
    size = os.path.getsize(bundle)
    # A 5 KiB bundle is a shell that resolves its imports at runtime; the real
    # one carries the extension's classes and is measured in megabytes.
    if size < 1024 * 1024:
        fail("%s is only %d bytes, which is not a bundle of the extension's services" % (bundle, size))
    print("bundle %s %d bytes in %.1f s" % (bundle, size, elapsed))


if __name__ == "__main__":
    main()
