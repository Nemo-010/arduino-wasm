#!/usr/bin/env python3
"""Serve the web/ directory for the browser build.

    python3 scripts/serve.py [--port 8000] [--open]

WebAssembly is fetched with `WebAssembly.instantiateStreaming`, which requires
`Content-Type: application/wasm`. Python's mimetypes does not know the type on
every platform, so it is set here explicitly. Nothing is cached, because the
point of the page is to run whatever the last build produced.
"""

import argparse
import functools
import http.server
import pathlib
import socketserver
import sys
import webbrowser

WEB_DIR = pathlib.Path(__file__).resolve().parent.parent / "web"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--open", action="store_true", help="open the page in a browser")
    args = parser.parse_args()

    if not (WEB_DIR / "arduino-cli.wasm").is_file():
        print(f"no wasm at {WEB_DIR / 'arduino-cli.wasm'}; run scripts/update.py first", file=sys.stderr)
        return 1

    handler = functools.partial(Handler, directory=str(WEB_DIR))
    url = f"http://127.0.0.1:{args.port}/"
    with Server(("127.0.0.1", args.port), handler) as httpd:
        print(f"serving {WEB_DIR} at {url}")
        if args.open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
