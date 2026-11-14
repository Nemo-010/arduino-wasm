#!/usr/bin/env node
// Boots the real Arduino IDE frontend (the Electron app's Theia frontend, built
// for the browser target) in headless Chrome over the DevTools pipe and checks
// that the shell renders with the in-page backend installed.
//
//   node test/ide.mjs [--wait 15000] [--shot build/ide-boot.png]
//
// Exit: 0 ok, 1 failed check, 2 skipped (no chrome or no build).

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, CHROME } from './cdp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE = join(ROOT, 'build/ide-dist/frontend/index.html');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? fallback : process.argv[i + 1];
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
}

async function main() {
  if (!existsSync(CHROME)) {
    console.log('SKIP: chrome not found at ' + CHROME);
    return 2;
  }
  if (!existsSync(PAGE)) {
    console.log('SKIP: no IDE build at ' + PAGE);
    console.log('      run: python3 scripts/build-ide.py --reuse');
    return 2;
  }

  const waitMs = Number(arg('wait', '15000'));
  const shot = arg('shot', join(ROOT, 'build/ide-boot.png'));
  const result = await launch({ url: 'file://' + PAGE, waitMs, shot });
  const state = result.state;
  const bodyText = (state.bodyText || '').replace(/\u00a0/g, ' ');
  const title = state.title || '';
  let calls = [];
  try {
    calls = JSON.parse(state.calls || '[]');
  } catch {
    calls = [];
  }

  check('shell rendered', state.hasShell, state.bodyLength + ' chars of body text');
  check('window title names the IDE', /Arduino IDE/.test(title), title);
  check('in-page backend installed', state.inpageInstalled === true, state.inpageInstalled);
  check(
    'backend answered RPC',
    calls.length > 0,
    calls.length + ' calls, first: ' + (calls[0] ? calls[0].path + ' ' + calls[0].method : 'none'),
  );
  // A method the frontend asks for and nobody answers comes back `undefined`,
  // which reaches `.filter()`/`.map()` further up and shows as a TypeError with
  // no clue where it came from. Failing here names the method instead.
  let missing = [];
  try {
    missing = JSON.parse(state.missing || '[]');
  } catch {
    missing = [];
  }
  check(
    'every boot RPC has an implementation',
    missing.length === 0,
    missing.length === 0
      ? 'none unimplemented'
      : missing.length + ' unimplemented: ' +
        missing.slice(0, 6).map(m => m.path + ' ' + m.method).join(', '),
  );
  check('toolbar rendered', /Select Board/.test(bodyText), bodyText.slice(0, 80));
  check(
    'a sketch is open in the editor',
    /void setup\(\)/.test(bodyText) && /\.ino/.test(bodyText),
    bodyText.slice(0, 120),
  );
  // The app logs its own lifecycle; 'ready' is the state after the workbench
  // UI is up, so this reads a stage rather than a rendering guess.
  const consoleText = (result.console || []).map(entry => entry.text).join('\n');
  const ready = /Changed application state from 'initialized_layout' to 'ready'/.test(consoleText);
  const boot = /Finished ([\d.]+) s after frontend start/.exec(consoleText);
  check('workbench reached ready', ready, boot ? boot[1] + ' s after frontend start' : 'no ready transition logged');

  for (const { name, ok, detail } of checks) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
  }
  console.log('');
  console.log('page:   ' + state.url);
  console.log('shot:   ' + shot);
  const failed = checks.filter(c => !c.ok);
  console.log(failed.length === 0 ? 'all ' + checks.length + ' checks passed' : failed.length + ' FAILED');
  return failed.length === 0 ? 0 : 1;
}

main().then(
  code => process.exit(code),
  error => {
    console.error('error: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
  },
);
