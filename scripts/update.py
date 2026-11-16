#!/usr/bin/env python3
"""Rebuild the browser build of arduino-cli from an upstream release tag.

This script is the update mechanism. It clones arduino-cli at a tag, copies the
small overlay in this repository into the clone, applies the build fixes that
the wasm target needs, compiles the CLI for GOOS=js, and writes the artefacts
into web/ together with a version manifest. Nothing in the clone is patched by
hand, so updating is: run this script again with a newer tag.

Usage:
    python3 scripts/update.py                 # latest upstream release
    python3 scripts/update.py --tag v1.6.0    # a specific release
    python3 scripts/update.py --reuse         # rebuild the existing clone

Requires Go (>= 1.24) on PATH, or GO=/path/to/go.
"""

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
WEB = os.path.join(ROOT, "web")
OVERLAY = os.path.join(ROOT, "overlay")
REPO = "https://github.com/arduino/arduino-cli.git"


def log(message):
    print(message, flush=True)


def run(args, cwd=None, env=None):
    log("+ " + " ".join(args))
    result = subprocess.run(args, cwd=cwd, env=env)
    if result.returncode != 0:
        sys.exit("failed: " + " ".join(args))


def go_bin():
    return os.environ.get("GO", "go")


def latest_tag():
    url = "https://api.github.com/repos/arduino/arduino-cli/releases/latest"
    request = urllib.request.Request(url, headers={"User-Agent": "arduino-wasm-build"})
    with urllib.request.urlopen(request, timeout=60) as response:
        release = json.load(response)
    return release["tag_name"]


def copy_overlay(src):
    """Copy our files over the clone. Overlaid files replace upstream files."""
    for directory, _, files in os.walk(OVERLAY):
        for name in files:
            source = os.path.join(directory, name)
            relative = os.path.relpath(source, OVERLAY)
            target = os.path.join(src, relative)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copyfile(source, target)
            log("overlay " + relative)


def patch_sync(src):
    """SyncTree's Unix implementation uses golang.org/x/sys/unix, absent on js.

    The file is small and generic; excluding js makes the build fall back to a
    no-op, which is correct: there is no filesystem to flush.
    """
    path = os.path.join(src, "internal/arduino/utils/sync_others.go")
    with open(path) as handle:
        text = handle.read()
    if "&& !js" in text:
        return
    text = text.replace("//go:build !linux && !windows", "//go:build !linux && !windows && !js")
    with open(path, "w") as handle:
        handle.write(text)
    log("patched internal/arduino/utils/sync_others.go for js")


def patch_tool_host(src):
    """Let the wasm host choose the tool host triple.

    Platforms are matched against tool flavours by runtime.GOOS/GOARCH. On js
    those are "js"/"wasm", which appear in no package index, so tool download
    would fail for every platform that has tools. The call sites are redirected
    to two helpers supplied by the overlay; the count assertions below make an
    upstream rename fail the build instead of silently drifting.
    """
    path = os.path.join(src, "internal/arduino/cores/tools.go")
    with open(path) as handle:
        text = handle.read()
    if "toolHostOS()" in text:
        return
    replacements = [
        (
            "return tr.GetFlavourFor(runtime.GOOS, forcedArch)",
            "return tr.GetFlavourFor(toolHostOS(), forcedArch)",
        ),
        (
            "return tr.GetFlavourCompatibleWith(runtime.GOOS, runtime.GOARCH)",
            "return tr.GetFlavourCompatibleWith(toolHostOS(), toolHostArch())",
        ),
    ]
    for old, new in replacements:
        if text.count(old) != 1:
            sys.exit(
                "internal/arduino/cores/tools.go changed upstream; "
                "expected exactly one occurrence of: " + old
            )
        text = text.replace(old, new)
    if text.count('\t"runtime"\n') != 1:
        sys.exit("internal/arduino/cores/tools.go: unexpected runtime import")
    text = text.replace('\t"runtime"\n', "")
    with open(path, "w") as handle:
        handle.write(text)
    log("patched internal/arduino/cores/tools.go for the tool host triple")


def patch_cors_gateway(src):
    """Route HTTP through a CORS gateway when one is configured.

    On js the HTTP client is fetch(), and fetch is what enforces CORS. An index
    or a release asset that sends no access-control-allow-origin is unreadable
    from a page, though the same code works under Node or on a desktop. Both
    places that build an HTTP client get the wrapper; the count assertions make
    an upstream rewrite fail the build instead of shipping a silent no-op.
    """
    path = os.path.join(src, "internal/cli/configuration/network.go")
    with open(path) as handle:
        text = handle.read()
    if "gatewayTransport(" in text:
        return
    replacements = [
        (
            "\t\t\ttransport: maybeWrapWithGitHubAuth(&http.Transport{\n\t\t\t\tProxy: http.ProxyURL(proxy),\n\t\t\t}),",
            "\t\t\ttransport: gatewayTransport(maybeWrapWithGitHubAuth(&http.Transport{\n\t\t\t\tProxy: http.ProxyURL(proxy),\n\t\t\t})),",
        ),
        (
            "\t\t\tTransport: maybeWrapWithGitHubAuth(&http.Transport{\n\t\t\t\tProxy: http.ProxyURL(proxy),\n\t\t\t}),",
            "\t\t\tTransport: gatewayTransport(maybeWrapWithGitHubAuth(&http.Transport{\n\t\t\t\tProxy: http.ProxyURL(proxy),\n\t\t\t})),",
        ),
    ]
    for old, new in replacements:
        if text.count(old) != 1:
            sys.exit(
                "internal/cli/configuration/network.go changed upstream; "
                "expected exactly one occurrence of: " + old
            )
        text = text.replace(old, new)
    with open(path, "w") as handle:
        handle.write(text)
    log("patched internal/cli/configuration/network.go for the CORS gateway")


def patch_js_directories(src):
    """Give the js build the same default directories as Linux.

    `getDefaultArduinoDataDir` and `getDefaultUserDir` switch on runtime.GOOS
    and name exactly linux, darwin and windows. Under wasm GOOS is "js", which
    matches none of them, so both fall through to `return "."` -- and a page
    with a data directory of "." installs cores into the root of its own
    virtual filesystem and tells the IDE the sketchbook is "/". js has a POSIX
    filesystem and HOME, so it takes the linux branch.
    """
    path = os.path.join(src, "internal/cli/configuration/configuration.go")
    with open(path) as handle:
        text = handle.read()
    if 'case "linux", "js":' in text:
        return
    replacements = [
        (
            '\tcase "linux":\n\t\treturn filepath.Join(userHomeDir, ".arduino15")',
            '\tcase "linux", "js":\n\t\treturn filepath.Join(userHomeDir, ".arduino15")',
        ),
        (
            '\tcase "linux":\n\t\treturn filepath.Join(userHomeDir, "Arduino")',
            '\tcase "linux", "js":\n\t\treturn filepath.Join(userHomeDir, "Arduino")',
        ),
    ]
    for old, wanted in replacements:
        if text.count(old) != 1:
            sys.exit(
                "internal/cli/configuration/configuration.go changed upstream; "
                "expected exactly one occurrence of: " + repr(old)
            )
        text = text.replace(old, wanted)
    with open(path, "w") as handle:
        handle.write(text)
    log("patched default directories for js")


def patch_discovery_loading(src):
    """Do not load discovery tools, or install them, under js.

    A discovery is a native executable the CLI spawns and talks to over a pipe,
    and a browser cannot start one. Two places have to agree on that:

    * `LoadDiscoveries` -- otherwise `Init` reports the missing builtin
      discoveries, which the IDE reads as "update the indexes", retries, fails
      the same way, and never settles its client.
    * `Init` -- otherwise the first browser run downloads ELF binaries it can
      never execute, from a host that sends no CORS header.

    A count assertion on each anchor makes an upstream rewrite fail the build
    instead of shipping a silent no-op.
    """
    discovery = os.path.join(src, "internal/arduino/cores/packagemanager/loader.go")
    with open(discovery) as handle:
        text = handle.read()
    if "DiscoveriesCanBeSpawned()" in text:
        return
    old = """func (pme *Explorer) LoadDiscoveries() []error {
\tvar merr []error"""
    new = """func (pme *Explorer) LoadDiscoveries() []error {
\tif !DiscoveriesCanBeSpawned() {
\t\treturn nil
\t}
\tvar merr []error"""
    if text.count(old) != 1:
        sys.exit(
            "internal/arduino/cores/packagemanager/loader.go changed upstream; "
            "expected exactly one occurrence of: " + old
        )
    with open(discovery, "w") as handle:
        handle.write(text.replace(old, new))

    instances = os.path.join(src, "commands/instances.go")
    with open(instances) as handle:
        text = handle.read()
    old = """\t\t// Install builtin tools if necessary
\t\tif len(builtinToolsToInstall) > 0 {"""
    new = """\t\t// The builtin tools are discovery executables; a browser cannot run them,
\t\t// so it must not fetch them either.
\t\tif !packagemanager.DiscoveriesCanBeSpawned() {
\t\t\tbuiltinToolsToInstall = nil
\t\t}
\t\t// Install builtin tools if necessary
\t\tif len(builtinToolsToInstall) > 0 {"""
    if text.count(old) != 1:
        sys.exit(
            "commands/instances.go changed upstream; "
            "expected exactly one occurrence of: " + old
        )
    with open(instances, "w") as handle:
        handle.write(text.replace(old, new))
    log("patched discovery loading for js")


def module_dir_of(src, env, module):
    """Absolute path of a module in the module cache, downloading it first.

    `go list -m` reports a directory only for a module already in the cache; on
    a cold machine it prints an empty line instead of fetching, so the caller
    has to ask for the download explicitly.
    """

    def lookup():
        result = subprocess.run(
            [go_bin(), "list", "-m", "-f", "{{.Dir}}", module],
            cwd=src, env=env, capture_output=True, text=True,
        )
        if result.returncode != 0:
            sys.exit("cannot locate " + module + ": " + result.stderr)
        return result.stdout.strip()

    found = lookup()
    if found:
        return found
    log("downloading " + module)
    if subprocess.run([go_bin(), "mod", "download", module], cwd=src, env=env).returncode != 0:
        sys.exit("cannot download " + module)
    found = lookup()
    if not found:
        sys.exit("cannot locate " + module + " after downloading it")
    return found


def vendor_pb(src, env):
    """Give github.com/cmaglie/pb a js build.

    arduino-cli's commands package imports internal/cli/feedback, which imports
    the progress-bar library pb. pb's Unix file is tagged for the BSD/Linux
    kernels only, so on js the package is missing terminalWidth(). We keep the
    library stock and add one build-tagged file that returns a fixed width.
    """
    gomod = os.path.join(src, "go.mod")
    with open(gomod) as handle:
        text = handle.read()
    # Resolve the module from the module cache, not from a previous replace.
    stripped = "\n".join(line for line in text.splitlines() if "=> ./third_party/pb" not in line)
    with open(gomod, "w") as handle:
        handle.write(stripped)

    module_dir = module_dir_of(src, env, "github.com/cmaglie/pb")

    target = os.path.join(src, "third_party", "pb")
    if os.path.isdir(target):
        for directory, dirs, files in os.walk(target):
            os.chmod(directory, 0o755)
            for name in files:
                os.chmod(os.path.join(directory, name), 0o644)
        shutil.rmtree(target)
    shutil.copytree(module_dir, target, ignore=shutil.ignore_patterns(".git"))
    for directory, dirs, files in os.walk(target):
        os.chmod(directory, 0o755)
        for name in files:
            os.chmod(os.path.join(directory, name), 0o644)

    with open(os.path.join(target, "go.mod"), "w") as handle:
        handle.write("module github.com/cmaglie/pb\n\ngo 1.21\n")

    with open(os.path.join(target, "pb_js.go"), "w") as handle:
        handle.write(
            "//go:build js\n\n"
            "package pb\n\n"
            "import \"errors\"\n\n"
            "// terminalWidth is not available in a browser; bars are unused there.\n"
            "func terminalWidth() (int, error) {\n"
            "\treturn 0, errors.New(\"terminal width is not available in wasm\")\n"
            "}\n"
        )

    with open(gomod, "w") as handle:
        handle.write(stripped + "\nreplace github.com/cmaglie/pb => ./third_party/pb\n")
    log("vendored github.com/cmaglie/pb with a js terminalWidth")


def vendor_paths_helper(src, env):
    """Give go-paths-helper's Process a way to run a command without the OS.

    Every external command arduino-cli runs (compiler, ctags, ar, objcopy) goes
    through paths.Process, which is a thin wrapper around os/exec. Under js there
    is no os/exec, so the wrapper needs one hook points that a page can fill: it
    keeps the library stock and adds a var that Start consults.

    The library is vendored into third_party/ and patched here, with an asserted
    replacement count for each edit, so an upstream change fails the build
    instead of silently producing a wasm that cannot compile anything.
    """
    gomod = os.path.join(src, "go.mod")
    with open(gomod) as handle:
        text = handle.read()
    marker = "replace github.com/arduino/go-paths-helper => ./third_party/go-paths-helper"
    stripped = "\n".join(line for line in text.splitlines() if "=> ./third_party/go-paths-helper" not in line)
    with open(gomod, "w") as handle:
        handle.write(stripped)

    module_dir = module_dir_of(src, env, "github.com/arduino/go-paths-helper")
    target = os.path.join(src, "third_party", "go-paths-helper")
    if os.path.isdir(target):
        for directory, dirs, files in os.walk(target):
            os.chmod(directory, 0o755)
            for name in files:
                os.chmod(os.path.join(directory, name), 0o644)
        shutil.rmtree(target)
    shutil.copytree(module_dir, target, ignore=shutil.ignore_patterns(".git"))
    for directory, dirs, files in os.walk(target):
        os.chmod(directory, 0o755)
        for name in files:
            os.chmod(os.path.join(directory, name), 0o644)

    path = os.path.join(target, "process.go")
    with open(path) as handle:
        text = handle.read()

    if "RunExternal" in text:
        log("go-paths-helper already patched")
    else:
        replacements = [
            (
                "type Process struct {\n\tcmd *exec.Cmd\n}",
                "type Process struct {\n"
                "\tcmd *exec.Cmd\n"
                "\n"
                "\t// Set when RunExternal handled the command, so Wait reports its\n"
                "\t// result instead of waiting for a process that never started.\n"
                "\texternalDone bool\n"
                "\texternalErr  error\n"
                "}\n"
                "\n"
                "// RunExternal, when not nil, runs a command instead of the operating\n"
                "// system and reports whether it handled it. A wasm build installs one\n"
                "// because it has no processes to start: the command runs in the page.\n"
                "var RunExternal func(cmd *exec.Cmd) (handled bool, err error)",
            ),
            (
                "func (p *Process) Start() error {\n\treturn p.cmd.Start()\n}",
                "func (p *Process) Start() error {\n"
                "\tif RunExternal != nil {\n"
                "\t\tif handled, err := RunExternal(p.cmd); handled {\n"
                "\t\t\tp.externalDone, p.externalErr = true, err\n"
                "\t\t\treturn nil\n"
                "\t\t}\n"
                "\t}\n"
                "\treturn p.cmd.Start()\n}",
            ),
            (
                "func (p *Process) Wait() error {\n"
                "\t// TODO: make some helpers to retrieve exit codes out of *ExitError.\n"
                "\treturn p.cmd.Wait()\n}",
                "func (p *Process) Wait() error {\n"
                "\t// TODO: make some helpers to retrieve exit codes out of *ExitError.\n"
                "\tif p.externalDone {\n"
                "\t\treturn p.externalErr\n"
                "\t}\n"
                "\treturn p.cmd.Wait()\n}",
            ),
            (
                "func (p *Process) Kill() error {\n\treturn kill(p.cmd)\n}",
                "func (p *Process) Kill() error {\n"
                "\tif p.externalDone {\n"
                "\t\treturn nil\n"
                "\t}\n"
                "\treturn kill(p.cmd)\n}",
            ),
            (
                "func (p *Process) Signal(sig os.Signal) error {\n\treturn p.cmd.Process.Signal(sig)\n}",
                "func (p *Process) Signal(sig os.Signal) error {\n"
                "\tif p.externalDone {\n"
                "\t\treturn nil\n"
                "\t}\n"
                "\treturn p.cmd.Process.Signal(sig)\n}",
            ),
        ]
        for old, new in replacements:
            if text.count(old) != 1:
                sys.exit(
                    "go-paths-helper/process.go changed upstream; "
                    "expected exactly one occurrence of: " + old.splitlines()[0]
                )
            text = text.replace(old, new)
        with open(path, "w") as handle:
            handle.write(text)
        log("patched go-paths-helper/process.go for RunExternal")

    with open(gomod, "w") as handle:
        handle.write(stripped.rstrip("\n") + "\n" + marker + "\n")


def build(src, env):
    os.makedirs(WEB, exist_ok=True)
    wasm = os.path.join(WEB, "arduino-cli.wasm")
    run(
        [
            go_bin(), "build",
            "-trimpath",
            "-ldflags", "-s -w",
            "-o", wasm,
            "./wasm",
        ],
        cwd=src,
        env=env,
    )

    goroot = subprocess.run(
        [go_bin(), "env", "GOROOT"], env=env, capture_output=True, text=True, check=True
    ).stdout.strip()
    shutil.copyfile(os.path.join(goroot, "lib/wasm/wasm_exec.js"), os.path.join(WEB, "wasm_exec.js"))
    return wasm


def git(src, *args):
    result = subprocess.run(["git"] + list(args), cwd=src, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit("git failed: " + result.stderr)
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", help="upstream release tag (default: latest)")
    parser.add_argument("--reuse", action="store_true", help="rebuild src/arduino-cli in place")
    parser.add_argument("--src", default=os.path.join(BUILD, "arduino-cli"))
    args = parser.parse_args()

    tag = args.tag
    src = args.src
    if not args.reuse:
        if not tag:
            tag = latest_tag()
        if os.path.isdir(src):
            shutil.rmtree(src)
        os.makedirs(BUILD, exist_ok=True)
        log("cloning arduino-cli " + tag)
        run(["git", "clone", "--depth", "1", "--branch", tag, REPO, src])
    else:
        tag = tag or git(src, "describe", "--tags", "--exact-match")

    env = dict(os.environ)
    env.update({
        "GOOS": "js",
        "GOARCH": "wasm",
        "GOFLAGS": "-mod=mod",
    })
    env.setdefault("GOTOOLCHAIN", "local")
    # Keep the heavy Go caches off small tmpfs mounts.
    env["GOCACHE"] = os.environ.get("GOCACHE", os.path.join(BUILD, "gocache"))
    env["GOMODCACHE"] = os.environ.get("GOMODCACHE", os.path.join(BUILD, "gomod"))
    env["GOTMPDIR"] = os.environ.get("GOTMPDIR", os.path.join(BUILD, "gotmp"))
    for key in ("GOCACHE", "GOMODCACHE", "GOTMPDIR"):
        os.makedirs(env[key], exist_ok=True)

    copy_overlay(src)
    patch_sync(src)
    patch_tool_host(src)
    patch_cors_gateway(src)
    patch_discovery_loading(src)
    patch_js_directories(src)
    vendor_pb(src, env)
    vendor_paths_helper(src, env)
    wasm = build(src, env)

    version = (tag or "unknown") + " " + git(src, "rev-parse", "--short", "HEAD")
    manifest = {
        "arduinoCli": tag,
        "commit": git(src, "rev-parse", "HEAD"),
        "go": subprocess.run([go_bin(), "version"], env=env, capture_output=True, text=True).stdout.strip(),
        "built": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "wasmBytes": os.path.getsize(wasm),
    }
    with open(os.path.join(WEB, "version.json"), "w") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    log(json.dumps(manifest, indent=2))
    log("built " + version)


if __name__ == "__main__":
    main()
