// A fetch that answers from test/fixtures. This sandbox cannot listen on any
// interface, so the fixture "server" is a function instead of a socket. Go's
// net/http still runs in full: it builds the request, parses the status,
// headers and body, and streams the response. Only the socket underneath is
// missing, and a browser supplies that part natively.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ORIGIN = "http://fixtures.test";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

let generated = false;

// The fixture index and archives are built, not committed: fixtures.py writes
// them deterministically. Generating them on first use keeps a fresh checkout
// running the tests with one command.
function ensureFixtures() {
  if (generated) return;
  generated = true;
  if (existsSync(path.join(fixtures, "package_fixture_index.json"))) return;
  execFileSync("python3", [path.join(here, "fixtures.py")], { stdio: "inherit" });
}

export function fixtureFetch(requests = []) {
  return async (input, init = {}) => {
    ensureFixtures();
    const url = new URL(typeof input === "string" ? input : input.url);
    const name = path.basename(url.pathname);
    let body;
    try {
      body = await readFile(path.join(fixtures, name));
    } catch {
      return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain" } });
    }
    if (url.pathname.endsWith(".json")) {
      body = Buffer.from(body.toString("utf8").replaceAll("{{BASE}}", url.origin));
    }

    const headers = new Headers(init.headers);
    const range = headers.get("range");
    let status = 200;
    const responseHeaders = {
      "content-type": url.pathname.endsWith(".json") ? "application/json" : "application/zip",
      "accept-ranges": "bytes",
    };
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) + 1 : body.length;
        responseHeaders["content-range"] = `bytes ${start}-${end - 1}/${body.length}`;
        body = body.subarray(start, end);
        status = 206;
      }
    }
    responseHeaders["content-length"] = String(body.length);
    requests.push({ method: init.method ?? "GET", path: url.pathname, range: range ?? null, bytes: body.length });
    return new Response(body, { status, headers: responseHeaders });
  };
}
