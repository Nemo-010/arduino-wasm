#!/usr/bin/env python3
"""A CORS gateway for arduino-wasm.

A page cannot read a response that omits access-control-allow-origin, and some
vendor indices and release assets omit it. This server fetches the URL you name
and returns the bytes with the header a browser requires, so the wasm CLI can
install those cores from a static page.

Run it somewhere the page can reach: the same machine, or a Tailscale address
if you want it private to your own network.

    python3 scripts/gateway.py --port 8787
    # then, in the page or the harness:
    ARDUINO_CORS_GATEWAY=http://127.0.0.1:8787

The CLI asks for GET /u/<base64url of the target URL>. URLs are base64url so a
query string in the target cannot be confused with this server's own, and no
escaping layer has to agree twice about what a URL looks like.

Only https targets are fetched, and only the bodies and headers a download
needs are passed through. This is not a general-purpose open proxy: point it at
your loopback or your own network, not at the public Electrosphere.
"""

import base64
import argparse
import http.server
import sys
import urllib.error
import urllib.parse
import urllib.request

# Passed through from upstream: what a downloader needs to resume and to know
# what it received. Everything else, including any access-control-* header the
# origin happened to send, is dropped in favour of ours.
FORWARDED = {
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "content-disposition",
}

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-None-Match, If-Modified-Since, Accept",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
}

PASSTHROUGH_REQUEST = ("Range", "If-None-Match", "If-Modified-Since", "Accept")

CHUNK = 64 * 1024


def encode_target(url):
    return base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")


def decode_target(segment):
    padded = segment + "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")


def target_allowed(url, allow_http=False):
    """https by default; http only when explicitly permitted (local testing)."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "https":
        return bool(parsed.netloc)
    if allow_http and parsed.scheme == "http":
        return bool(parsed.netloc)
    return False


def forwarded_headers(upstream):
    kept = {}
    for key, value in upstream.items():
        if key.lower() in FORWARDED:
            kept[key.title()] = value
    return kept


def fetch(target, headers, timeout):
    """Fetch the target and return (status, headers, body).

    Redirects are followed: a release asset answers 302 and the bytes live at
    the redirect destination.
    """
    request = urllib.request.Request(target, headers=headers, method="GET")
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        # An origin's refusal is the answer: pass the status and body through
        # rather than presenting it as this server's own failure.
        return error.code, dict(error.headers), error
    return response.status, dict(response.headers), response


class GatewayHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    allow_http = False
    timeout_seconds = 60

    fetch = staticmethod(fetch)

    def log_message(self, fmt, *args):
        sys.stderr.write("gateway %s\n" % (fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        for key, value in CORS.items():
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.handle_request(head_only=True)

    def do_GET(self):
        self.handle_request(head_only=False)

    def handle_request(self, head_only):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/healthz":
            self.send_plain(200, b"ok\n", head_only)
            return
        if not path.startswith("/u/"):
            self.send_plain(404, b"GET /u/<base64url>\n", head_only)
            return

        try:
            target = decode_target(path[len("/u/"):])
        except (ValueError, UnicodeDecodeError):
            self.send_plain(400, b"target is not base64url\n", head_only)
            return

        if not target_allowed(target, self.allow_http):
            self.send_plain(403, b"only https targets are fetched\n", head_only)
            return

        headers = {}
        for name in PASSTHROUGH_REQUEST:
            value = self.headers.get(name)
            if value:
                headers[name] = value

        try:
            status, upstream, body = self.fetch(target, headers, self.timeout_seconds)
        except Exception as error:  # network, DNS, TLS: report, do not hang
            self.send_plain(502, ("upstream failed: %s\n" % error).encode(), head_only)
            return

        try:
            self.send_response(status)
            for key, value in forwarded_headers(upstream).items():
                self.send_header(key, value)
            for key, value in CORS.items():
                self.send_header(key, value)
            length = upstream.get("Content-Length") or upstream.get("content-length")
            if length is None and not head_only:
                self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            if head_only:
                return

            chunked = length is None
            while True:
                chunk = body.read(CHUNK)
                if not chunk:
                    break
                if chunked:
                    self.wfile.write(b"%x\r\n" % len(chunk))
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                else:
                    self.wfile.write(chunk)
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
        finally:
            body.close()

    def send_plain(self, status, text, head_only):
        self.send_response(status)
        for key, value in CORS.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(text)))
        self.end_headers()
        if not head_only:
            self.wfile.write(text)


class GatewayServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


def serve(host, port, allow_http, timeout):
    GatewayHandler.allow_http = allow_http
    GatewayHandler.timeout_seconds = timeout
    server = GatewayServer((host, port), GatewayHandler)
    print("gateway on http://%s:%d  (GET /u/<base64url>)" % (host, port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def self_test():
    """Checks that need no socket: the encoding and the header filter."""
    cases = [
        "https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json",
        "https://github.com/a/b/releases/download/c/d.tar.bz2?x=1&y=2",
        "https://example.test/a%20b?q=%26",
    ]
    for case in cases:
        assert decode_target(encode_target(case)) == case, case
        assert target_allowed(case), case
    assert not target_allowed("http://example.test/x")
    assert target_allowed("http://example.test/x", allow_http=True)
    assert not target_allowed("file:///etc/passwd")
    assert not target_allowed("https:///nohost")

    kept = forwarded_headers(
        {
            "Content-Type": "application/octet-stream",
            "Content-Length": "10",
            "Content-Range": "bytes 0-9/10",
            "Access-Control-Allow-Origin": "https://origin.test",
            "Set-Cookie": "no=thankyou",
        }
    )
    assert kept == {
        "Content-Type": "application/octet-stream",
        "Content-Length": "10",
        "Content-Range": "bytes 0-9/10",
    }, kept
    assert CORS["Access-Control-Allow-Origin"] == "*"
    print("gateway self-test passed")


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--allow-http", action="store_true", help="also fetch http:// targets")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    serve(args.host, args.port, args.allow_http, args.timeout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
