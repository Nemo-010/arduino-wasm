// Drive headless Chrome over its debugging pipe.
//
// Binding a TCP port is refused in this sandbox, so `--remote-debugging-pipe`
// is the only way in: Chrome reads commands from fd 3 and writes replies to
// fd 4, with messages separated by NUL bytes. This is enough to load a page,
// collect its console, evaluate expressions in it and take a screenshot.
//
// Usage: node test/cdp.mjs <url> [--wait ms] [--shot out.png] [--eval expr]

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CHROME =
  process.env.ARDUINO_WASM_CHROME || '/workspace/.scratch/chrome/chrome-linux64/chrome';

// Chrome keeps writing its profile after the browser is told to close. A
// single rmSync in a finally clause then fails with ENOTEMPTY and turns a green
// test red. Retry briefly, and ignore a directory that is still busy: a fresh
// profile per run is the point, and the next run uses a different path.
export async function removeProfile(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error && error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

class Pipe {
  constructor(readStream, writeStream) {
    this.writeStream = writeStream;
    this.buffer = Buffer.alloc(0);
    this.next = 1;
    this.pending = new Map();
    this.listeners = [];
    readStream.on('data', chunk => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(0);
      if (end < 0) {
        return;
      }
      const raw = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      if (!raw) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        // Never reject: a dead or busy renderer turns every later command into
        // an error, and a driver that throws loses the console log that says why.
        resolve({ __error: `${message.error.message} (${message.error.code})` });
      } else {
        resolve(message.result);
      }
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) {
        listener(message);
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeStream.write(`${JSON.stringify(payload)}\0`);
      setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ __error: `timed out waiting for ${method}` });
        }
      }, 60000);
    });
  }

  onEvent(listener) {
    this.listeners.push(listener);
  }
}

export async function launch({
  url,
  waitMs = 20000,
  shot,
  evaluate,
  steps = [],
  profile = '/workspace/.scratch/chrome-profile-ide',
  preScript,
}) {
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + profile,
      '--window-size=1440,900',
      '--remote-debugging-pipe',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );

  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));

  const console_ = [];
  const exceptions = [];
  const requests = new Map();
  const failed = [];

  // Replies come back on Chrome's write end, which is a different descriptor
  // from the one commands go out on. One object owns both, or responses are
  // dispatched into a queue nothing is waiting on.
  const commands = new Pipe(child.stdio[4], child.stdio[3]);
  commands.onEvent(message => {
    const params = message.params || {};
    if (message.method === 'Network.requestWillBeSent') {
      requests.set(params.requestId, params.request.url);
    } else if (message.method === 'Network.loadingFailed') {
      failed.push({
        url: requests.get(params.requestId) || params.requestId,
        error: params.errorText,
      });
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const text = (params.args || [])
        .map(arg => arg.value ?? arg.description ?? arg.unserializableValue ?? arg.type)
        .join(' ');
      console_.push({ level: params.type, text });
      if (console_.length > 2000) {
        console_.splice(0, 1000);
      }
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      exceptions.push(
        details.exception?.description || details.text || 'unknown exception',
      );
      if (exceptions.length > 50) {
        exceptions.length = 50;
      }
    } else if (message.method === 'Log.entryAdded') {
      console_.push({ level: params.entry.level, text: params.entry.text });
      if (console_.length > 2000) {
        console_.splice(0, 1000);
      }
    } else if (
      message.method === 'Inspector.targetCrashed' ||
      message.method === 'Target.targetCrashed'
    ) {
      exceptions.push('renderer crashed: ' + (params.status || params.errorCode || 'unknown'));
    }
  });

  // Chrome attaches its pipe reader some time after exec; a command written
  // before that is dropped silently and only surfaces as a timeout.
  await new Promise(resolve => setTimeout(resolve, 500));

  const { targetId } = await commands.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await commands.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  await commands.send('Runtime.enable', {}, sessionId);
  await commands.send('Network.enable', {}, sessionId);
  // A reused profile serves app.js from its own cache, so a test would grade
  // the previous deploy. GitHub Pages allows a ten-minute cache, which is right
  // for a reader and wrong for a driver.
  await commands.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  // Code the caller needs to run before the page's own scripts: the IDE page
  // reads its index configuration from localStorage, and a test that set it
  // afterwards would grade the URL the previous run left behind.
  if (preScript) {
    await commands.send('Page.addScriptToEvaluateOnNewDocument', { source: preScript }, sessionId);
  }
  // Trap errors raised before the page's own code can report them.
  await commands.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: [
        'window.__errors = [];',
        "addEventListener('error', e => window.__errors.push('error: ' + (e.message || String(e.error))));",
        "addEventListener('unhandledrejection', e => window.__errors.push('rejection: ' + String((e.reason && e.reason.stack) || e.reason)));",
      ].join('\n'),
    },
    sessionId,
  );
  await commands.send('Log.enable', {}, sessionId);
  await commands.send('Page.enable', {}, sessionId);
  await commands.send('Inspector.enable', {}, sessionId);
  await commands.send('Page.navigate', { url }, sessionId);

  await new Promise(resolve => setTimeout(resolve, waitMs));

  // A stuck main thread answers nothing, so every probe is bounded: a hung
  // evaluate must still leave the console and the screenshot readable.
  const probe = async expression => {
    const call = commands.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: false },
      sessionId,
    );
    const bounded = new Promise(resolve =>
      setTimeout(() => resolve({ result: { value: '<probe timed out: main thread busy>' } }), 8000),
    );
    try {
      const result = await Promise.race([call, bounded]);
      if (result.__error) {
        return '<' + result.__error + '>';
      }
      return result.result?.value;
    } catch (error) {
      return '<probe failed: ' + error.message + '>';
    }
  };

  const state = {
    title: await probe('document.title'),
    url: await probe('location.href'),
    hasShell: await probe('!!document.querySelector(".theia-ApplicationShell")'),
    bodyLength: await probe('document.body.innerText.length'),
    bodyText: await probe('document.body.innerText.slice(0, 1200)'),
    calls: await probe('JSON.stringify((window.__inpageCalls || []).slice(0, 400))'),
    missing: await probe('JSON.stringify((window.__inpageMissing || []).slice(0, 80))'),
    inpageInstalled: await probe('Array.isArray(window.__inpageCalls)'),
    errors: await probe('JSON.stringify(window.__errors || [])'),
    bodyHtmlLength: await probe('document.body.innerHTML.length'),
  };

  if (evaluate) {
    state.evaluated = await probe(evaluate);
  }

  // A page whose work takes minutes — installing a 23 MB core, compiling a
  // sketch — cannot be driven by one evaluate. Steps wait on this side and read
  // on that side, so the page's own event loop stays free between them.
  if (steps.length > 0) {
    state.steps = [];
    for (const step of steps) {
      if (step.until) {
        // A step that waits for a condition is bounded and says so: an expired
        // stop records the last value it read, so a stall is diagnosable rather
        // than looking like an assertion that was never reached.
        const deadline = Date.now() + (step.timeout || 300000);
        let value;
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, step.wait || 3000));
          value = await probe(step.evaluate);
          if (step.until(value)) {
            break;
          }
          if (Date.now() > deadline) {
            value = "<until expired after " + Math.round((step.timeout || 300000) / 1000) + "s: " + value + ">";
            break;
          }
        }
        state.steps.push(value);
        continue;
      }
      if (step.wait) {
        await new Promise(resolve => setTimeout(resolve, step.wait));
      }
      if (step.evaluate) {
        state.steps.push(await probe(step.evaluate));
      }
    }
  }

  if (shot) {
    const capture = commands.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const bounded = new Promise(resolve => setTimeout(() => resolve(undefined), 15000));
    const shotResult = await Promise.race([capture, bounded]);
    if (shotResult?.data) {
      mkdirSync(dirname(shot), { recursive: true });
      writeFileSync(shot, Buffer.from(shotResult.data, 'base64'));
    } else {
      state.screenshot = '<capture timed out>';
    }
  }

  child.kill('SIGKILL');
  return { console: console_, exceptions, state, failed, stderr: stderr.join('') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const url = args[0];
  if (!url) {
    console.error('usage: node test/cdp.mjs <url> [--wait ms] [--shot out.png]');
    process.exit(2);
  }
  const option = name => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const result = await launch({
    url,
    waitMs: Number(option('--wait') || 20000),
    shot: option('--shot'),
    evaluate: option('--eval'),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.exceptions.length ? 1 : 0);
}
