#!/usr/bin/env python3
"""Build the tiny POSIX-serial wasm probe used by test/serial-wasm.mjs.

Requires Emscripten 4.0.10 (the version pinned by build-arm-tools.py). The
tool's own source is only a fixture; the real product uses scripts/serial-shim.c
to link any upload tool the same way. Output is committed so CI needs no emcc.
"""
import os, subprocess, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
EMSDK = os.environ.get("EMSDK") or str(ROOT.parent / ".scratch/toolchain/emsdk")
src = ROOT / "test/fixtures/serial-tool.c"
shim = ROOT / "scripts/serial-shim.c"
out = ROOT / "test/fixtures/serial-tool.mjs"
env = dict(os.environ, EMSDK=EMSDK)
subprocess.run([
    os.path.join(EMSDK, "upstream/emscripten/emcc"),
    str(src), str(shim), "-O0",
    "-s", "ENVIRONMENT=node", "-s", "EXIT_RUNTIME=1", "-s", "MODULARIZE=1",
    "-s", "EXPORT_NAME=createSerialTool", "-s", "ASYNCIFY=1",
    "-s", "EXPORTED_RUNTIME_METHODS=[\"FS\",\"callMain\",\"HEAPU8\"]",
    "-Wl,--wrap=read", "-o", str(out),
], env=env, check=True, cwd=ROOT)
print("built", out)
