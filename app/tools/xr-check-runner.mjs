#!/usr/bin/env node
// Orchestrates `npm run xr:check` with guaranteed xr exit and sessionActive check (F1, F2).
// Steps: dev restart (world via VITE_DREAMER_WORLD) → wait for browser → browser run (settle world)
// → xr enter (retry until offered) → browser run (check, no reload) → xr status → xr exit (always).
import { spawnSync } from 'node:child_process';

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, stdio: opts.stdio ?? 'inherit', encoding: opts.encoding });
  return r;
}

let browserCode = 0;
let browserSignal = null;
let statusOk = true;
let statusOutput = '';
let xrExitCode = 0;
let xrExitSignal = null;

// The world comes from VITE_DREAMER_WORLD (pickWorld fallback), so the app loads it on
// first paint and xr-check.mjs never reloads the frame under an open XR session.
process.env.VITE_DREAMER_WORLD = process.env.DREAMER_WORLD || 'koshakan';
const dev = run('iwsdk dev restart --headless --allow-browser-automation');
if (dev.signal || dev.status !== 0) process.exit(dev.status ?? 1);

// `dev up` returns while the managed browser is still launching; `xr enter` then
// fails with "Browser not ready". Poll runtime status until the browser runs (60 s).
function browserReady() {
  const st = run('iwsdk runtime status', { stdio: 'pipe', encoding: 'utf8' });
  try {
    const b = JSON.parse(st.stdout).data.result.browser;
    return b.lifecycle.state === 'running' && b.status === 'connected';
  } catch {
    return false;
  }
}
const readyBy = Date.now() + 60_000;
while (!browserReady()) {
  if (Date.now() > readyBy) {
    console.error('xr-check: managed browser not ready in 60 s');
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 500));
}

// Settle the world before the session: a pass that has to reload the frame (stale
// localStorage world) runs here, so the in-session pass below never reloads.
run('iwsdk browser run tools/xr-check.mjs', { stdio: 'pipe', encoding: 'utf8' });

try {
  // The app offers the session only after World.create; retry until offered (30 s).
  let enter;
  for (const enterBy = Date.now() + 30_000; ; ) {
    enter = run('iwsdk xr enter', { stdio: 'pipe', encoding: 'utf8' });
    if (enter.status === 0 || !/No session has been offered|not ready/i.test(enter.stdout + enter.stderr) || Date.now() > enterBy) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (enter.stdout) process.stdout.write(enter.stdout);
  if (enter.stderr) process.stderr.write(enter.stderr);
  if (enter.signal || enter.status !== 0) {
    browserCode = enter.status ?? 1;
    browserSignal = enter.signal;
  } else {
    // X3: hold the stick forward during the in-session pass; xr-check.mjs samples the walk for 8 s
    process.env.XR_WALK = '1';
    run(`iwsdk xr set-gamepad-state --input-json '{"device":"controller-left","axes":[{"index":0,"value":0},{"index":1,"value":-1}]}'`, { stdio: 'pipe', encoding: 'utf8' });
    const br = run('iwsdk browser run tools/xr-check.mjs', { stdio: 'pipe', encoding: 'utf8' });
    run(`iwsdk xr set-gamepad-state --input-json '{"device":"controller-left","axes":[{"index":0,"value":0},{"index":1,"value":0}]}'`, { stdio: 'pipe', encoding: 'utf8' });
    if (br.stdout) process.stdout.write(br.stdout);
    if (br.stderr) process.stderr.write(br.stderr);
    browserSignal = br.signal;
    browserCode = br.signal ? 1 : br.status;
    // The script returns { ok, code }; the CLI wraps it in data.result.
    if (browserCode === 0) {
      try {
        const code = JSON.parse(br.stdout.slice(br.stdout.indexOf('{\n'))).data.result.code;
        browserCode = Number.isInteger(code) ? code : 1;
      } catch {
        browserCode = 1;
      }
    }

    const st = run('iwsdk xr status', { stdio: 'pipe', encoding: 'utf8' });
    // xr status output may be JSON or text; echo for visibility
    if (st.stdout) {
      process.stdout.write(st.stdout);
      statusOutput = st.stdout;
    }
    if (st.stderr) process.stderr.write(st.stderr);
    if (st.signal || st.status !== 0) {
      statusOk = false;
    } else {
      // check sessionActive === true
      let active = false;
      const out = statusOutput;
      try {
        const j = JSON.parse(out);
        if (j.sessionActive === true) active = true;
        else if (j.data && j.data.sessionActive === true) active = true;
        else if (typeof j === 'object') {
          // search any nested sessionActive
          const s = JSON.stringify(j);
          if (s.includes('"sessionActive":true') || s.includes('"sessionActive": true')) active = true;
        }
      } catch {
        // fallback text search: must be true, not false
        if (out.includes('sessionActive') && out.includes('true') && !out.includes('"sessionActive": false')) {
          // naive but require explicit true
          active = out.includes('"sessionActive": true') || out.includes('sessionActive: true') || out.includes('sessionActive:true');
          if (!active) {
            // if output contains true somewhere near sessionActive, consider active
            active = /sessionActive[^a-zA-Z0-9]*true/i.test(out);
          }
        }
      }
      // strict: sessionActive must be true
      if (!active) statusOk = false;
    }
  }
} finally {
  // F1: always exit XR session even if browser run failed (code 4 etc.)
  const ex = run('iwsdk xr exit');
  const err = ex.error;
  if (err) {
    xrExitCode = 1;
    xrExitSignal = null;
  } else {
    xrExitCode = ex.status;
    xrExitSignal = ex.signal;
  }
}

// Priority: browser error first, then sessionActive, then xr exit
if (browserSignal) process.exit(1);
if (browserCode !== 0 && browserCode !== null) process.exit(browserCode);
if (browserCode === null) process.exit(1);
if (!statusOk) {
  console.error('xr-check: sessionActive !== true');
  process.exit(1);
}
if (xrExitSignal) process.exit(1);
if (xrExitCode !== 0 && xrExitCode !== null) process.exit(xrExitCode);
if (xrExitCode === null) process.exit(1);
process.exit(0);
