#!/usr/bin/env python3
"""Generate a self-contained Arduino package and library index for the tests.

The point is to exercise the real install code paths (index parse, zip
download, checksum verification, extract, directory rename, library layout
validation) without depending on downloads.arduino.cc, which is blocked from
some networks.

Every URL in the generated indexes is the literal string {{BASE}}. The test
server substitutes its own origin, so the port is decided at run time.

Usage: python3 test/fixtures.py [--out test/fixtures]
"""

import argparse
import hashlib
import io
import json
import os
import zipfile

HOST = "x86_64-pc-linux-gnu"
PLATFORM_VERSION = "1.0.0"
TOOL_VERSION = "1.0.0"
LIBRARY_VERSION = "1.0.0"


def zipped(entries):
    """Build a zip in memory from {name: bytes}."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            info = zipfile.ZipInfo(name, date_time=(2024, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            archive.writestr(info, content)
    return buffer.getvalue()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def core_zip():
    # The installer requires exactly one directory at the archive root and
    # moves that directory into packages/<packager>/hardware/<arch>/<version>.
    return zipped({
        "testavr/platform.txt": (
            "name=Test AVR Boards\n"
            "version=" + PLATFORM_VERSION + "\n"
            "compiler.path={runtime.tools.testtool.path}/bin/\n"
            "recipe.c.o.pattern=\"{compiler.path}testtool\"\n"
            "upload.tool=testtool\n"
            "upload.protocol=serial\n"
            "upload.tool.serial=testtool\n"
            "upload.pattern=\"{compiler.path}testtool\" -Uflash:w:{build.path}/{build.project_name}.hex:i\n"
        ).encode(),
        "testavr/boards.txt": (
            "testboard.name=Test Board\n"
            "testboard.build.core=arduino\n"
            "testboard.build.board=TEST_BOARD\n"
            # Lets BoardIdentify match a WebSerial port's vendor/product ids.
            "testboard.vid.0=0x2341\n"
            "testboard.pid.0=0x0043\n"
        ).encode(),
        "testavr/cores/arduino/Arduino.h": b"#pragma once\n",
        "testavr/cores/arduino/main.cpp": b"int main() { return 0; }\n",
    })


def tool_zip():
    return zipped({
        "testtool-" + TOOL_VERSION + "/bin/testtool": b"#!/bin/sh\nexit 0\n",
        "testtool-" + TOOL_VERSION + "/README.txt": b"fixture tool\n",
    })


def library_zip():
    return zipped({
        "TestLib/library.properties": (
            "name=TestLib\n"
            "version=" + LIBRARY_VERSION + "\n"
            "author=Fixture\n"
            "maintainer=Fixture\n"
            "sentence=A test library.\n"
            "paragraph=A library used to verify install behaviour.\n"
            "category=Other\n"
            "url=https://example.com\n"
            "architectures=*\n"
        ).encode(),
        "TestLib/src/TestLib.h": b"#pragma once\nint testlib_answer();\n",
        "TestLib/src/TestLib.cpp": b"#include \"TestLib.h\"\nint testlib_answer() { return 42; }\n",
        "TestLib/examples/Blink/Blink.ino": b"void setup() {}\nvoid loop() {}\n",
    })


def package_index(core, tool):
    return {
        "packages": [
            {
                "name": "testpkg",
                "maintainer": "Fixture",
                "websiteURL": "https://example.com",
                "email": "fixture@example.com",
                "help": {"online": "https://example.com/help"},
                "platforms": [
                    {
                        "name": "Test AVR Boards",
                        "architecture": "avr",
                        "version": PLATFORM_VERSION,
                        "category": "Contributed",
                        "url": "{{BASE}}/core-testavr-" + PLATFORM_VERSION + ".zip",
                        "archiveFileName": "core-testavr-" + PLATFORM_VERSION + ".zip",
                        "checksum": "SHA-256:" + sha256(core),
                        "size": str(len(core)),
                        "boards": [{"name": "Test Board"}],
                        "toolsDependencies": [
                            {
                                "packager": "testpkg",
                                "name": "testtool",
                                "version": TOOL_VERSION,
                            }
                        ],
                    }
                ],
                "tools": [
                    {
                        "name": "testtool",
                        "version": TOOL_VERSION,
                        "systems": [
                            {
                                "host": HOST,
                                "url": "{{BASE}}/testtool-" + TOOL_VERSION + ".zip",
                                "archiveFileName": "testtool-" + TOOL_VERSION + ".zip",
                                "checksum": "SHA-256:" + sha256(tool),
                                "size": str(len(tool)),
                            }
                        ],
                    }
                ],
            }
        ]
    }


def library_index(library):
    return {
        "libraries": [
            {
                "name": "TestLib",
                "version": LIBRARY_VERSION,
                "author": "Fixture",
                "maintainer": "Fixture",
                "sentence": "A test library.",
                "paragraph": "A library used to verify install behaviour.",
                "website": "https://example.com",
                "category": "Other",
                "architectures": ["*"],
                "types": ["Contributed"],
                "url": "{{BASE}}/TestLib-" + LIBRARY_VERSION + ".zip",
                "archiveFileName": "TestLib-" + LIBRARY_VERSION + ".zip",
                # The library index stores size as a number and the checksum
                # as one prefixed string, unlike the package index which
                # stores both as strings.
                "size": len(library),
                "checksum": "SHA-256:" + sha256(library),
                "dependencies": [],
            }
        ]
    }


def write(path, data):
    with open(path, "wb") as handle:
        handle.write(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures"))
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)

    core = core_zip()
    tool = tool_zip()
    library = library_zip()

    # The package index name matters: the CLI looks for package_*_index.json.
    write(os.path.join(args.out, "package_fixture_index.json"),
          json.dumps(package_index(core, tool), indent=2).encode())
    write(os.path.join(args.out, "library_index.json"),
          json.dumps(library_index(library), indent=2).encode())
    write(os.path.join(args.out, "core-testavr-1.0.0.zip"), core)
    write(os.path.join(args.out, "testtool-1.0.0.zip"), tool)
    write(os.path.join(args.out, "TestLib-1.0.0.zip"), library)

    for name in sorted(os.listdir(args.out)):
        path = os.path.join(args.out, name)
        print(name, os.path.getsize(path))


if __name__ == "__main__":
    main()
