// Prove that ARDUINO_CORS_GATEWAY rewrites the URL the wasm CLI asks for.
//
// The rewrite happens in Go's transport, so this checks the observable thing: a
// fetch that only accepts gateway-shaped URLs still serves every request, and
// the encoded target decodes back to the URL the CLI meant to reach. A second
// instance runs without the variable, so the difference is shown rather than
// assumed.
//
// The two instances are needed because Go 1.27's js ABI copies the environment
// into linear memory at startup (wasm_exec.js writes argv and env into the same
// block), so os.Getenv cannot change after the program has started.

import { startCLI } from "./harness.mjs";
import { fixtureFetch, FIXTURE_ORIGIN } from "./fixture-fetch.mjs";

// startCLI replaces globalThis.process with the wasm shim, so keep the real one.
const realProcess = process;

const GATEWAY = "https://gateway.test";
const PREFIX = GATEWAY + "/u/";

let failures = 0;
function check(ok, what) {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) failures++;
}

const seen = [];
const forwarded = [];

function gatewayFetch() {
  const inner = fixtureFetch();
  return async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    seen.push(url);
    if (url.startsWith(PREFIX)) {
      const target = Buffer.from(url.slice(PREFIX.length), "base64url").toString();
      forwarded.push(target);
      return inner(target, init);
    }
    return inner(url, init);
  };
}

const settings = [
  "directories:",
  "  data: /home/arduino/.arduino15",
  "  downloads: /home/arduino/.arduino15/staging",
  "  user: /home/arduino/Arduino",
].join("\n");

async function boot(extraEnv) {
  const origin = FIXTURE_ORIGIN;
  const cli = await startCLI({
    fetch: gatewayFetch(),
    env: {
      ARDUINO_DEFAULT_INDEX_URL: origin + "/package_fixture_index.json",
      ARDUINO_LIBRARIES_INDEX_URL: origin + "/library_index.json",
      ARDUINO_TOOL_HOST_OS: "linux",
      ARDUINO_TOOL_HOST_ARCH: "amd64",
      ...extraEnv,
    },
  });
  await cli.call("ConfigurationOpen", { encoded_settings: settings, settings_format: "yaml" });
  const created = await cli.call("Create", {});
  const instance = created.find((event) => event.type === "result").data.instance;
  return { cli, instance };
}

async function throughGateway() {
  const origin = FIXTURE_ORIGIN;
  console.log("\nWith ARDUINO_CORS_GATEWAY set");
  const { cli, instance } = await boot({ ARDUINO_CORS_GATEWAY: GATEWAY });

  let seenMark = seen.length;
  let forwardedMark = forwarded.length;

  const update = await cli.call("UpdateIndex", { instance, update_if_older_than_secs: 0 });
  const reports = update.flatMap((event) => event.data?.updatedIndexes ?? []);
  const packageUrls = seen.slice(seenMark);
  console.log("  asked for: " + packageUrls.join("\n             "));
  check(packageUrls.length > 0, "the index download made a request");
  check(
    packageUrls.every((url) => url.startsWith(PREFIX)),
    "every request goes to the gateway, not to the origin",
  );
  check(
    forwarded.slice(forwardedMark).includes(origin + "/package_fixture_index.json"),
    "the encoded target decodes back to the index URL",
  );
  check(reports.some((report) => report.status === "STATUS_UPDATED"), "the index still parses and installs");

  seenMark = seen.length;
  forwardedMark = forwarded.length;
  const libraries = await cli.call("UpdateLibrariesIndex", { instance, update_if_older_than_secs: 0 });
  const libraryUrls = seen.slice(seenMark);
  check(
    libraryUrls.length > 0 && libraryUrls.every((url) => url.startsWith(PREFIX)),
    "the library index download is rewritten too",
  );
  check(
    forwarded.slice(forwardedMark).includes(origin + "/library_index.json"),
    "the library index target decodes back to its URL",
  );
  check(
    libraries.flatMap((event) => (event.data?.librariesIndex ? [event.data.librariesIndex] : []))
      .some((report) => report.status === "STATUS_UPDATED"),
    "the library index still parses and installs",
  );

  // An instance only knows the packages its Init loaded, so reload the index
  // that was just installed before asking the instance about a platform.
  await cli.call("Init", { instance });

  // The platform archive goes through the downloader, which builds its own
  // HTTP client; this is the other call site the patch has to cover.
  seenMark = seen.length;
  forwardedMark = forwarded.length;
  await cli.call(
    "PlatformInstall",
    { instance, platform_package: "testpkg", architecture: "avr", version: "1.0.0", skip_post_install: true },
    { timeoutMs: 180000 },
  );
  const installUrls = seen.slice(seenMark);
  const archives = forwarded.slice(forwardedMark).filter((url) => /\.(tar\.bz2|tar\.gz|zip)$/.test(url));
  console.log("  archive targets: " + archives.join(", "));
  check(installUrls.length > 0, "the install made requests");
  check(
    installUrls.every((url) => url.startsWith(PREFIX)),
    "the downloader's own client also goes through the gateway",
  );
  check(archives.length > 0, "an archive was fetched by its real URL through the gateway");
}

async function withoutGateway() {
  const origin = FIXTURE_ORIGIN;
  console.log("\nWithout ARDUINO_CORS_GATEWAY");
  const { cli, instance } = await boot({});

  const seenMark = seen.length;
  await cli.call("UpdateIndex", { instance, update_if_older_than_secs: 0 });
  const directUrls = seen.slice(seenMark);
  console.log("  asked for: " + directUrls.join("\n             "));
  check(directUrls.length > 0, "the index download made a request");
  check(
    directUrls.every((url) => url.startsWith(origin)),
    "the requests go straight to the origin",
  );
  check(
    directUrls.every((url) => !url.startsWith(PREFIX)),
    "no request is routed through a gateway that was not configured",
  );
}

async function main() {
  await throughGateway();
  await withoutGateway();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall gateway rewrite checks passed");
  return failures ? 1 : 0;
}

try {
  realProcess.exit(await main());
} catch (error) {
  console.error(error);
  realProcess.exit(1);
}
