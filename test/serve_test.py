#!/usr/bin/env python3
"""Check scripts/serve.py over a socket pair.

The sandbox refuses to bind any address, so the handler is driven directly
through one end of a socketpair. Everything under test is the real handler:
routing, the wasm content type, and the no-store header. What this cannot show
is a browser's reaction to those headers.

    python3 test/serve_test.py
"""

import importlib.util
import pathlib
import socket
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_serve():
    spec = importlib.util.spec_from_file_location("serve", ROOT / "scripts" / "serve.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(serve, raw):
    client, server = socket.socketpair()
    # BaseRequestHandler.__init__ runs setup(), handle() and finish(), so the
    # handler serves the request as soon as it is constructed.
    failure = []

    def serve_one():
        try:
            serve.Handler(server, ("127.0.0.1", 0), None, directory=str(serve.WEB_DIR))
        except Exception as error:  # pragma: no cover - reported as a failure
            failure.append(error)

    thread = threading.Thread(target=serve_one, daemon=True)
    thread.start()
    try:
        client.sendall(raw)
        client.shutdown(socket.SHUT_WR)
        # The server end stays open in this process, so the client never sees
        # EOF; stop when the handler goes quiet instead.
        client.settimeout(2.0)
        chunks = []
        while True:
            try:
                chunk = client.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        client.close()
        server.close()
        thread.join(timeout=5)
    if failure:
        raise failure[0]
    head, _, _body = b"".join(chunks).partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return lines[0], headers


def check(condition, message):
    if not condition:
        raise SystemExit("FAILED: " + message)
    print("  ok  " + message)


def main():
    serve = load_serve()

    check(serve.WEB_DIR.is_dir(), "the web directory resolves next to the script")
    check(
        serve.Handler.extensions_map.get(".wasm") == "application/wasm",
        "wasm is served as application/wasm (instantiateStreaming needs it)",
    )

    status, headers = request(serve, b"HEAD /arduino-cli.wasm HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    check("200" in status, "the wasm file is found: " + status)
    check(headers.get("content-type") == "application/wasm", "the wasm response carries the right type")
    check(headers.get("cache-control") == "no-store", "responses are not cached")

    status, headers = request(serve, b"GET /index.html HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    check("200" in status, "the page is found: " + status)
    check(headers.get("content-type", "").startswith("text/html"), "the page is served as html")

    status, headers = request(serve, b"GET /app.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    check("200" in status, "app.js is found: " + status)
    check("javascript" in headers.get("content-type", ""), "app.js is served as javascript")

    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
