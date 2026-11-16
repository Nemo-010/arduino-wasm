#!/usr/bin/env python3
"""Build the real Arduino IDE frontend (Theia) as a page.

Upstream arduino-ide is an Electron app: a Theia frontend plus a Theia Node
backend.  The build keeps the app's own `electron` target -- five of its browser
contributions inject a service only the electron window module binds -- and skips
the one step that belongs to that target's runtime, Electron's own preparation;
`scripts/ide-build.cjs` records why and does it.  Its postinstall steps download arduino-cli, the language server, the
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
import hashlib
import io
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DEFAULT_TAG = "2.3.11"
NATIVES = ("drivelist", "keytar", "native-keymap", "node-pty")

# @vscode/ripgrep's postinstall asks api.github.com for the release, which
# answered 403 on a cold CI run. The release asset itself is reachable without
# the API; pin both the archive and the binary inside it. The binary hash is
# also the hash of the copy upstream's own postinstall fetched on 2026-11-13,
# so this asset has been corroborated by two independent downloads.
RIPGREP_TAG = "v13.0.0-10"
RIPGREP_ASSET = "ripgrep-%s-x86_64-unknown-linux-musl.tar.gz" % RIPGREP_TAG
RIPGREP_SHA256 = "ef820a62c1d6fdc396646762ff0f0e47e127947073ed8b5aa4ceea8b61cb1659"
RIPGREP_RG_SHA256 = "7cdd80707c2841da469a64be650fcdbaa76c6c80aa9e8bd823eb96cafc39f827"


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
        if sys.platform == "linux" and platform.machine() in ("x86_64", "amd64"):
            fetch_ripgrep(rg)
        else:
            # No pinned asset measured for this platform: let upstream decide,
            # and say so rather than pretending the pin covers every host.
            print("  => ripgrep: no pinned asset on this platform; using upstream's postinstall")
            run([which(env, "node"), "./lib/postinstall.js"], rg, env,
                BUILD / "ide-ripgrep.log", "@vscode/ripgrep postinstall")


def fetch_ripgrep(rg):
    url = ("https://github.com/microsoft/ripgrep-prebuilt/releases/download/"
           + RIPGREP_TAG + "/" + RIPGREP_ASSET)
    request = urllib.request.Request(url, headers={"User-Agent": "arduino-wasm-build/1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        archive = response.read()
    digest = hashlib.sha256(archive).hexdigest()
    if digest != RIPGREP_SHA256:
        die("ripgrep archive sha256 %s, expected %s" % (digest, RIPGREP_SHA256))
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        binary = tar.extractfile(tar.getmember("rg")).read()
    binary_digest = hashlib.sha256(binary).hexdigest()
    if binary_digest != RIPGREP_RG_SHA256:
        die("ripgrep binary sha256 %s, expected %s" % (binary_digest, RIPGREP_RG_SHA256))
    target = rg / "bin" / "rg"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary)
    target.chmod(0o755)
    print("  => ripgrep from %s (sha256 %s)" % (RIPGREP_ASSET, digest[:12]))


def install_inpage(app):
    # The in-page backend replaces Theia's backend transport inside the frontend
    # bundle. Copied rather than kept in the clone so re-cloning upstream does
    # not lose it.
    src, dst = ROOT / "ide/inpage", app / "inpage"
    for module in sorted(src.glob("*.js")):
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(module, dst / module.name)
    print("  => inpage modules: %d" % len(list(dst.glob("*.js"))))


def patch_entry(app):
    # `theia build` regenerates src-gen/, so this runs afterwards. The insertion
    # asserts its match count: an upstream change to the generated entry must
    # stop the build, not silently ship a page with no backend.
    entry = app / "src-gen/frontend/index.js"
    text = entry.read_text()

    def replace_once(old, new):
        nonlocal text
        if new in text:
            return
        count = text.count(old)
        if count != 1:
            die("%s: expected 1 occurrence of %r, found %d" % (entry, old, count))
        text = text.replace(old, new)

    replace_once(
        "    container.load(messagingFrontendModule);",
        "    container.load(messagingFrontendModule);\n"
        "    require('../../inpage/inpage-backend-module');\n"
        "    require('../../inpage/inpage-backend-module').install(container);",
    )
    entry.write_text(text)
    print("  => entry patched: %d hooks" % text.count("inpage-backend-module"))


def rebundle_frontend(app, env):
    # Only the frontend entry changed, and its filesystem cache is warm: this is
    # seconds, where a second `theia build` is minutes.
    run([which(env, "webpack"), "--config", "gen-webpack.config.js"], app, env,
        BUILD / "ide-rebundle.log", "webpack frontend")


def build_app(app, env):
    # scripts/ide-build.cjs runs `theia build` with one method replaced: the
    # Electron runtime preparation, which needs node_modules/electron/dist and
    # downloads Electron's ffmpeg for a binary this project never runs. See that
    # file for why the app cannot declare a browser target instead.
    run([which(env, "node"), str(ROOT / "scripts" / "ide-build.cjs"), str(app)],
        app, env, BUILD / "ide-webpack.log", "theia build (Electron runtime skipped)")
    install_inpage(app)
    patch_entry(app)
    rebundle_frontend(app, env)


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


# The page's script tags: WasmExec installs `globalThis.Go`, ide-boot starts the
# CLI, services.js installs `ArduinoIdeServices`, and only then does Theia's own
# bundle run and find a backend.
PAGE_SCRIPTS = (
    "    <!-- the wasm CLI, then the services that speak to it, then the IDE -->\n"
    "    <script src=\"../wasm_exec.js\"></script>\n"
    "    <script src=\"ide-boot.js\"></script>\n"
    "    <script src=\"services.js\"></script>\n"
)
PAGE_BUNDLE_TAG = '<script type="text/javascript" src="./bundle.js" charset="utf-8"></script>'


def publish(out, services_bundle, frontend=None):
    """Copy the built IDE into the served tree and wire its page.

    `web/` is what the deploy uploads, so the IDE page has to live under it to be
    reachable at all. Its own assets are relative to `web/ide/`, while the wasm,
    the toolchains and the package indexes are the site's, one level up -- which
    is why this is a copy rather than a second build.
    """
    dst = ROOT / "web/ide"
    if dst.exists():
        shutil.rmtree(dst)
    # `frontend` lets a rebundled tree be republished without collecting it
    # into `out` first; the collected copy and the live one are the same files.
    shutil.copytree(Path(frontend) if frontend else out / "frontend", dst)
    # What ships is what the page loads. Devtools fetch `.map` files and nothing
    # else does; the `.gz` copies are for a server that pre-compresses, and
    # Pages compresses on the fly. Both stay in `build/ide-dist/` for debugging,
    # so the shipped tree is 33 MB instead of 119 MB.
    dropped = 0
    for path in list(dst.rglob("*")):
        if path.is_file() and path.suffix in (".map", ".gz"):
            dropped += path.stat().st_size
            path.unlink()
    shutil.copy2(services_bundle, dst / "services.js")
    shutil.copy2(ROOT / "web/ide-boot.js", dst / "ide-boot.js")

    index = dst / "index.html"
    text = index.read_text()
    count = text.count(PAGE_BUNDLE_TAG)
    if count != 1:
        die("%s: expected 1 bundle script tag, found %d" % (index, count))
    if "ide-boot.js" in text:
        die("%s already carries the page scripts" % index)
    index.write_text(text.replace(PAGE_BUNDLE_TAG, PAGE_SCRIPTS + "    " + PAGE_BUNDLE_TAG))

    size = sum(p.stat().st_size for p in dst.rglob("*") if p.is_file())
    print("published: %s (%d bytes, %d bytes of maps and precompressed copies left out)"
          % (dst.relative_to(ROOT), size, dropped))
    return dst


def main():
    ap = argparse.ArgumentParser(description="build arduino-ide for the browser")
    ap.add_argument("--tag", default=DEFAULT_TAG)
    ap.add_argument("--src", default=str(BUILD / "arduino-ide"))
    ap.add_argument("--out", default=str(BUILD / "ide-dist"))
    ap.add_argument("--reuse", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--services-bundle", default=str(BUILD / "ide-services/services.js"),
                    help="the bundle from scripts/build-ide-services.py")
    ap.add_argument("--no-publish", action="store_true",
                    help="leave web/ide alone (for a build that is only measured)")
    ap.add_argument("--publish-only", action="store_true",
                    help="collect and publish from the tree left by --no-publish, without rebuilding it")
    args = ap.parse_args()

    src, out = Path(args.src).resolve(), Path(args.out).resolve()
    node_dir = find_node()
    env = node_env(node_dir)
    # tsc, theia and npm all live in the workspace's node_modules/.bin.
    env["PATH"] = str(src / "node_modules/.bin") + ":" + env["PATH"]
    ext, app = src / "arduino-ide-extension", src / "electron-app"
    print("arduino-ide %s -> %s" % (args.tag, out))

    if args.publish_only:
        # CI builds the frontend once, then builds the services bundle, then
        # publishes. Running the whole script a second time to publish rebuilt
        # the app and hit ENOTEMPTY in theia's native-webpack-plugin cleanup.
        # collect() still runs: publishing a tree nobody collected hides a
        # broken build. The named artefacts are checked before anything moves.
        if not app.is_dir():
            die("--publish-only needs the clone built by --no-publish: %s" % src)
        built = app / "lib/frontend/bundle.js"
        if not built.is_file():
            die("%s is missing; build it with python3 scripts/build-ide.py --no-publish --reuse" % built)
        bundle = Path(args.services_bundle).resolve()
        if not bundle.is_file():
            die("%s is missing; build it with python3 scripts/build-ide-services.py" % bundle)
        collect(app, out, args.tag, node_dir / "node")
        publish(out, bundle)
        return 0

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
    if args.no_publish:
        print("  => web/ide left alone (--no-publish)")
    else:
        bundle = Path(args.services_bundle).resolve()
        if not bundle.is_file():
            die("%s is missing; build it with python3 scripts/build-ide-services.py" % bundle)
        publish(out, bundle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
