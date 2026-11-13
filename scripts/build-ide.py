#!/usr/bin/env python3
"""Build the real Arduino IDE frontend (Theia) for the browser target.

Upstream arduino-ide is an Electron app: a Theia frontend plus a Theia Node
backend.  Its postinstall steps download arduino-cli, the language server, the
firmware uploader and examples from downloads.arduino.cc, and build native Node
addons.  This script does only what the browser bundle needs, because the point
of this project is to run arduino-cli as wasm instead of shipping a binary.

Nothing in the upstream sources is patched.  The steps below recreate what
upstream's own postinstall would have produced: the i18n resources, the
generated protobuf JS next to the compiled node code, the native addons, the
ripgrep binary, and a placeholder where the downloaded binaries would live.

Usage:
    python3 scripts/build-ide.py
    python3 scripts/build-ide.py --tag 2.3.12
    python3 scripts/build-ide.py --reuse      # rebuild in the existing clone
    python3 scripts/build-ide.py --force      # redo addons and tsc too

Output: build/ide-dist/{frontend,backend} plus build.json.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DEFAULT_TAG = "2.3.11"
NATIVES = ("drivelist", "keytar", "native-keymap", "node-pty")


def die(msg):
    raise SystemExit("error: " + msg)


def run(cmd, cwd, env, log, label):
    print("  -> " + label, flush=True)
    with open(log, "wb") as out:
        code = subprocess.run([str(c) for c in cmd], cwd=str(cwd), env=env,
                              stdout=out, stderr=subprocess.STDOUT).returncode
    if code != 0:
        lines = Path(log).read_text(errors="replace").splitlines()[-25:]
        die("%s failed with exit %d\n  log: %s\n%s" % (
            label, code, log, "\n".join("    " + l for l in lines)))


def node_env(bin_dir):
    env = dict(os.environ)
    env["PATH"] = ":".join([str(bin_dir), env.get("PATH", "")])
    env.setdefault("NODE_OPTIONS", "--max-old-space-size=4096")
    env["ELECTRON_SKIP_BINARY_DOWNLOAD"] = "1"
    return env


def find_node():
    override = os.environ.get("ARDUINO_WASM_NODE_BIN")
    cands = [Path(override)] if override else []
    cands += [ROOT / ".scratch/toolchain/node-v24.11.1-linux-x64/bin",
              ROOT.parent / ".scratch/toolchain/node-v24.11.1-linux-x64/bin"]
    for cand in cands:
        if (cand / "node").exists():
            return cand
    found = shutil.which("node")
    if not found:
        die("node not found; set ARDUINO_WASM_NODE_BIN to a directory with node")
    return Path(found).parent


def which(env, name):
    path = shutil.which(name, path=env["PATH"])
    if not path:
        die("%s not found on PATH; is node_modules installed?" % name)
    return path


def clone(src, tag):
    if src.exists():
        shutil.rmtree(src)
    src.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "clone", "--depth", "1", "--branch", tag,
         "https://github.com/arduino/arduino-ide.git", src],
        ROOT, os.environ, BUILD / "ide-clone.log", "clone arduino-ide " + tag)


def install(root, env, reuse):
    if reuse and (root / "node_modules/.bin/theia").exists():
        print("  => node_modules present, skipping install")
        return
    # --ignore-scripts: upstream's postinstall fetches binaries from a host that
    # is blocked here and builds addons (both handled below).
    run(["corepack", "yarn", "install", "--ignore-scripts", "--ignore-engines",
         "--frozen-lockfile", "--network-timeout", "600000"],
        root, env, BUILD / "ide-install.log", "yarn install (scripts skipped)")


def prepare_inputs(ext):
    i18n_src, i18n_dst = ext.parent / "i18n", ext / "src/node/resources/i18n"
    if not i18n_src.is_dir():
        die("%s missing; clone is incomplete" % i18n_src)
    i18n_dst.mkdir(parents=True, exist_ok=True)
    for item in i18n_src.glob("*.json"):
        shutil.copy2(item, i18n_dst / item.name)
    if not list(i18n_dst.glob("*.json")):
        die("no i18n json copied to %s" % i18n_dst)
    # The webpack CopyPlugin globs src/node/resources/**/* while ignoring
    # i18n/**; upstream fills this with downloaded binaries.  With only i18n
    # present the glob matches nothing and webpack aborts.
    holder = ext / "src/node/resources/examples/PLACEHOLDER.txt"
    if not holder.exists():
        holder.parent.mkdir(parents=True, exist_ok=True)
        holder.write_text("arduino-cli, the language server, the firmware "
                          "uploader and examples are replaced by the wasm "
                          "arduino-cli in this build.\n")


def compile_extension(ext, env, force):
    if not (ext / "lib/browser/arduino-frontend-module.js").exists() or force:
        run([which(env, "tsc")], ext, env, BUILD / "ide-tsc.log", "tsc")
    # `postbuild` copies the generated protobuf JS next to the compiled node
    # code; webpack resolves ./cli-protocol/... at bundle time.
    src, dst = ext / "src/node/cli-protocol", ext / "lib/node/cli-protocol"
    if not src.is_dir():
        die("%s missing; clone is incomplete" % src)
    shutil.copytree(src, dst, dirs_exist_ok=True)


def gyp(env, cwd, log, label):
    gyp_js = BUILD / ".gyp/node_modules/node-gyp/bin/node-gyp.js"
    if not gyp_js.exists():
        # node-gyp 9 imports distutils, removed in Python 3.12.
        run([which(env, "npm"), "install", "--silent", "--prefix",
             str(BUILD / ".gyp"), "node-gyp@11"], ROOT, env,
            BUILD / "ide-gyp-install.log", "npm install node-gyp@11")
        if not gyp_js.exists():
            die("node-gyp not installed at %s" % gyp_js)
    run([which(env, "node"), gyp_js, "rebuild"], cwd, env, log, label)


def build_natives(root, env, force):
    # The Theia CLI itself loads @theia/ffmpeg's addon; a missing file throws
    # MODULE_NOT_FOUND instead of the intended fallback.
    ffmpeg = root / "node_modules/@theia/ffmpeg"
    if not (ffmpeg / "build/Release/ffmpeg.node").exists() or force:
        gyp(env, ffmpeg, BUILD / "ide-gyp-ffmpeg.log", "node-gyp @theia/ffmpeg")
    for name in NATIVES:
        pkg = root / "node_modules" / name
        if not pkg.is_dir():
            print("  => %s not installed, skipping" % name)
            continue
        if list((pkg / "build/Release").glob("*.node")) and not force:
            print("  => %s addon present" % name)
            continue
        gyp(env, pkg, BUILD / ("ide-gyp-%s.log" % name), "node-gyp " + name)
    rg = root / "node_modules/@vscode/ripgrep"
    if rg.is_dir() and not (rg / "bin/rg").exists():
        run([which(env, "node"), "./lib/postinstall.js"], rg, env,
            BUILD / "ide-ripgrep.log", "@vscode/ripgrep postinstall")


def build_app(app, env):
    # Theia's own flag is --app-target (values: browser|electron); --target is
    # forwarded to webpack, which only knows web/node/electron-main.
    run([which(env, "theia"), "build", "--app-target=browser"], app, env,
        BUILD / "ide-webpack.log", "theia build --app-target=browser")


def collect(app, out, tag, node):
    if out.exists():
        shutil.rmtree(out)
    manifest = {"tag": tag, "node": str(node), "files": 0}
    for part in ("frontend", "backend"):
        src = app / "lib" / part
        if not src.is_dir():
            die("%s was not produced" % src)
        shutil.copytree(src, out / part)
        size = sum(p.stat().st_size for p in (out / part).rglob("*") if p.is_file())
        manifest[part + "Bytes"] = size
        manifest["files"] += sum(1 for p in (out / part).rglob("*") if p.is_file())
    if not (out / "frontend/index.html").exists():
        die("frontend bundle has no index.html")
    (out / "build.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("done: %s" % out)
    print("  frontend %d bytes, backend %d bytes" % (
        manifest["frontendBytes"], manifest["backendBytes"]))
    return manifest


def main():
    ap = argparse.ArgumentParser(description="build arduino-ide for the browser")
    ap.add_argument("--tag", default=DEFAULT_TAG)
    ap.add_argument("--src", default=str(BUILD / "arduino-ide"))
    ap.add_argument("--out", default=str(BUILD / "ide-dist"))
    ap.add_argument("--reuse", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    src, out = Path(args.src).resolve(), Path(args.out).resolve()
    node_dir = find_node()
    env = node_env(node_dir)
    # tsc, theia and npm all live in the workspace's node_modules/.bin.
    env["PATH"] = str(src / "node_modules/.bin") + ":" + env["PATH"]
    ext, app = src / "arduino-ide-extension", src / "electron-app"
    print("arduino-ide %s -> %s" % (args.tag, out))

    if args.reuse:
        if not app.is_dir():
            die("--reuse given but %s is not a clone" % src)
        print("  => reusing existing clone")
    else:
        clone(src, args.tag)
    install(src, env, args.reuse)

    prepare_inputs(ext)
    compile_extension(ext, env, args.force)
    build_natives(src, env, args.force)
    build_app(app, env)
    collect(app, out, args.tag, node_dir / "node")
    return 0


if __name__ == "__main__":
    sys.exit(main())
