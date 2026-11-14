#!/usr/bin/env python3
"""Check scripts/gateway.py without binding a socket or touching the network.

The sandbox refuses to bind, so the handler is driven through one end of a
socketpair and the upstream fetch is replaced by a recorder. Everything else is
real: request parsing, the status line, header filtering, chunked framing and
the CORS headers a browser would read.

    python3 test/gateway_test.py
"""

import importlib.util
import io
import pathlib
import socket
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_gateway():
    spec = importlib.util.spec_from_file_location("gateway", ROOT / "scripts" / "gateway.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeUpstream:
    """Stands in for urllib: records the target and the headers it was given."""

    def __init__(self, status=200, headers=None, body=b"", error=None):
        self.status = status
        self.headers = headers if headers is not None else {"Content-Length": str(len(body))}
        self.body = body
        self.error = error
        self.calls = []

    def __call__(self, target, headers, timeout):
        self.calls.append({"target": target, "headers": dict(headers), "timeout": timeout})
        if self.error is not None:
            raise self.error
        return self.status, dict(self.headers), io.BytesIO(self.body)


def raw_request(gateway, raw, upstream, has_body=True):
    client, server = socket.socketpair()
    failure = []

    class Handler(gateway.GatewayHandler):
        fetch = staticmethod(upstream)

    def serve_one():
        try:
            Handler(server, ("127.0.0.1", 0), None)
        except Exception as error:  # pragma: no cover - reported as a failure
            failure.append(error)

    thread = threading.Thread(target=serve_one, daemon=True)
    thread.start()
    try:
        client.sendall(raw)
        client.shutdown(socket.SHUT_WR)
        client.settimeout(10)
        response = read_response(client, has_body)
    finally:
        client.close()
        thread.join(timeout=10)
    if failure:
        raise failure[0]
    return response


def read_response(client, has_body=True):
    buffer = b""
    while b"\r\n\r\n" not in buffer:
        chunk = client.recv(65536)
        if not chunk:
            raise AssertionError("connection closed before headers: %r" % buffer)
        buffer += chunk
    head, buffer = buffer.split(b"\r\n\r\n", 1)
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()

    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = b""
        while True:
            while b"\r\n" not in buffer:
                buffer += client.recv(65536)
            size_line, buffer = buffer.split(b"\r\n", 1)
            size = int(size_line.strip(), 16)
            if size == 0:
                break
            while len(buffer) < size + 2:
                buffer += client.recv(65536)
            body += buffer[:size]
            buffer = buffer[size + 2:]
        return status, headers, body

    length = int(headers.get("content-length", "0"))
    if not has_body:
        return status, headers, b""
    while len(buffer) < length:
        chunk = client.recv(65536)
        if not chunk:
            break
        buffer += chunk
    return status, headers, buffer[:length]


def get(path, upstream, method="GET", extra=""):
    gateway = load_gateway()
    raw = ("%s %s HTTP/1.1\r\nHost: gateway.test\r\n%s\r\n" % (method, path, extra)).encode()
    return raw_request(gateway, raw, upstream, has_body=(method != "HEAD"))


def main():
    gateway = load_gateway()
    gateway.self_test()

    target = "https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json"
    path = "/u/" + gateway.encode_target(target)
    payload = b'{"packages":[]}' * 100

    # A normal download: the bytes, the origin's type, and the header a page needs.
    upstream = FakeUpstream(headers={"Content-Type": "application/json", "Content-Length": str(len(payload))}, body=payload)
    status, headers, body = get(path, upstream, extra="Range: bytes=0-131\r\n")
    assert status == 200, status
    assert body == payload, (len(body), len(payload))
    assert headers["access-control-allow-origin"] == "*", headers
    assert headers["content-type"] == "application/json", headers
    assert upstream.calls[0]["target"] == target, upstream.calls
    assert upstream.calls[0]["headers"] == {"Range": "bytes=0-131"}, upstream.calls
    print("ok   a download is returned with the CORS header the origin omitted")

    # A partial response keeps its status and its range.
    upstream = FakeUpstream(
        status=206,
        headers={"Content-Length": "4", "Content-Range": "bytes 10-13/100", "Accept-Ranges": "bytes"},
        body=b"abcd",
    )
    status, headers, body = get(path, upstream, extra="Range: bytes=10-13\r\n")
    assert status == 206, status
    assert body == b"abcd", body
    assert headers["content-range"] == "bytes 10-13/100", headers
    assert headers["access-control-allow-origin"] == "*", headers
    print("ok   a ranged response stays 206 and keeps Content-Range")

    # No Content-Length upstream: the body must be framed so a browser can finish.
    upstream = FakeUpstream(headers={"Content-Type": "application/octet-stream"}, body=b"x" * 100000)
    status, headers, body = get(path, upstream)
    assert status == 200, status
    assert headers.get("transfer-encoding") == "chunked", headers
    assert body == b"x" * 100000, len(body)
    print("ok   a response without Content-Length is chunked and arrives whole")

    # An origin's refusal is passed through, still readable by the page.
    upstream = FakeUpstream(status=403, headers={"Content-Length": "9"}, body=b"forbidden")
    status, headers, body = get(path, upstream)
    assert status == 403, status
    assert body == b"forbidden", body
    assert headers["access-control-allow-origin"] == "*", headers
    print("ok   an upstream 403 is passed through with the CORS header")

    # A broken base64 is a request error, not a crash.
    status, headers, body = get("/u/not-base64!!", FakeUpstream())
    assert status == 400, status
    assert headers["access-control-allow-origin"] == "*", headers
    print("ok   a malformed target is a 400")

    # http:// is refused: this must not become an open proxy for plaintext.
    status, headers, body = get("/u/" + gateway.encode_target("http://example.test/x"), FakeUpstream())
    assert status == 403, status
    assert headers["access-control-allow-origin"] == "*", headers
    print("ok   an http:// target is refused")

    # A transport failure is reported as a gateway error, not a hang.
    status, headers, body = get(path, FakeUpstream(error=OSError("dns is down")))
    assert status == 502, status
    assert b"dns is down" in body, body
    assert headers["access-control-allow-origin"] == "*", headers
    print("ok   an upstream failure is a 502 the page can read")

    # Preflight.
    status, headers, body = get(path, FakeUpstream(), method="OPTIONS")
    assert status == 204, status
    assert headers["access-control-allow-origin"] == "*", headers
    assert headers["access-control-allow-methods"] == "GET, HEAD, OPTIONS", headers
    print("ok   OPTIONS answers a preflight")

    # HEAD reports the size without shipping the body.
    upstream = FakeUpstream(headers={"Content-Length": "1234"}, body=b"")
    status, headers, body = get(path, upstream, method="HEAD")
    assert status == 200, status
    assert headers["content-length"] == "1234", headers
    assert body == b"", body
    print("ok   HEAD reports Content-Length and no body")

    # Health check, so an operator can tell the gateway is up.
    status, headers, body = get("/healthz", FakeUpstream())
    assert status == 200, status
    assert body == b"ok\n", body
    print("ok   /healthz answers")

    print("\nall gateway checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
