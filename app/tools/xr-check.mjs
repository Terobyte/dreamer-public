// X2 check: `iwsdk browser run tools/xr-check.mjs` (run on `frame`, F10).
// Sets the world, waits for window.__dreamerXr, prints a JSON verdict.
// Exit codes (returned as `code`, applied by the runner): 0 ok, 1 check failed, 2 timeout (60 s), 3 glb.failed > 0, 4 report.error.
// The XR session is opened by `npm run xr:check` (xr enter / xr status / xr exit), not here.
const WORLD = process.env.DREAMER_WORLD || 'koshakan';
const TIMEOUT_MS = 60_000;
const POLL_MS = 250;

// The script runs inside the iwsdk CLI process: process.exit() would drop the managed
// browser lease and retire the browser (and the XR session). Return the verdict with its
// exit code instead; xr-check-runner.mjs reads `code` from `browser run` output.
function finish(verdict, code) {
  console.log(JSON.stringify(verdict));
  return { ...verdict, code };
}

// The app lives in IWSDK's `#workspace-runtime-frame` iframe. Reload that frame,
// not the top page: `page.reload()` recreates the iframe and detaches `frame`.
async function appFrame(page, frame) {
  if (frame && !frame.isDetached()) return frame;
  const el = await page.$('#workspace-runtime-frame').catch(() => null);
  return (el && (await el.contentFrame())) || page.mainFrame();
}

export default async function run({ page, frame }) {
  const target = await appFrame(page, frame);
  // Normally the runner serves the world via VITE_DREAMER_WORLD and the report already
  // exists: no reload, so an open XR session survives. Fallback: pick via localStorage.
  // localStorage outranks the env in pickWorld, and the managed browser keeps it between
  // runs: a stale stored world also forces the fallback.
  const [hasReport, stored] = await target
    .evaluate(() => [window.__dreamerXr != null, localStorage.getItem('dreamer.world')])
    .catch(() => [false, null]);
  if (!hasReport || (stored && stored !== WORLD)) {
    // Mark the old document: right after reload() it still answers with its stale report.
    await target.evaluate((w) => {
      localStorage.setItem('dreamer.world', w);
      window.__xrCheckStale = true;
    }, WORLD);
    if (target === page.mainFrame()) await page.reload();
    else await target.evaluate(() => location.reload()).catch(() => null);
  }
  const t0 = Date.now();
  let report;
  for (;;) {
    const f = await appFrame(page, frame);
    report = await f.evaluate(() => (window.__xrCheckStale ? null : window.__dreamerXr ?? null)).catch(() => null);
    if (report && (report.error || report.ready)) break;
    if (Date.now() - t0 > TIMEOUT_MS) return finish({ ok: false, reason: report ? 'timeout' : 'no __dreamerXr', report }, 2);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (report.error) return finish({ ok: false, reason: 'error', report }, 4);
  if (report.glb?.failed > 0) return finish({ ok: false, reason: 'glb.failed', report }, 3);
  const problems = [];
  if (report.oneThree !== true) problems.push('oneThree');
  if (report.glb?.ok !== report.glb?.total) problems.push('glb not all loaded');
  const [sx, sy, sz] = report.spawn ?? [];
  const [px, py, pz] = report.player ?? [];
  if (![sx, sy, sz, px, py, pz].every(Number.isFinite)) problems.push('spawn/player missing');
  else if (process.env.XR_WALK !== '1' && process.env.XR_DOORS !== '1' && (Math.abs(px - sx) > 0.05 || Math.abs(pz - sz) > 0.05 || Math.abs(py - sy) > 0.02)) problems.push('player not on spawn');
  // X3: the fence stops the player in the locomotor, so the nav guard never sees an off-nav frame
  if (report.offNav !== 0) problems.push('offNav != 0');
  if (problems.length) return finish({ ok: false, reason: problems, report }, 1);
  if (process.env.XR_DOORS === '1') return doors(frame ?? target, page, report);
  if (process.env.XR_WALK === '1') return walk(frame ?? target, page, report);
  return finish({ ok: true, report, xrBlocked: (report.passages ?? []).filter((d) => !d.xrOk) }, 0);
}

// X3 walk: the runner holds the stick forward (xr set-gamepad-state) while this samples the player for 8 s.
// Pass: the player left the spawn, stopped (the fence, not a push-back), stayed on the floor, never reversed along
// the stick axis (-Z), the host never re-placed the player, and the nav guard saw no off-nav frame.
// largest hole between consecutive samples, including the start and the 8 s end
export function maxGap(samples) {
  let prev = 0, gap = 0;
  for (const s of samples) { gap = Math.max(gap, s.t - prev); prev = s.t; }
  return Math.max(gap, 8000 - prev);
}

async function walk(frameOrPage, page, start) {
  const target = await appFrame(page, frameOrPage);
  const calls0 = start.setPlayerCalls;
  const [sx, sy, sz] = start.spawn;
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const r = await target.evaluate(() => ({ p: window.__dreamerXr.player.slice(), off: window.__dreamerXr.offNav, calls: window.__dreamerXr.setPlayerCalls, rev: window.__dreamerXr.reversals })).catch(() => null);
    if (r) samples.push({ t: Date.now() - t0, ...r });
    await new Promise((res) => setTimeout(res, 50));
  }
  const problems = [];
  if (samples.length < 20) problems.push('too few samples');
  else if (samples[samples.length - 1].t < 7800 || maxGap(samples) > 500) problems.push('samples do not cover the 8 s walk');
  else {
    const last = samples[samples.length - 1];
    // per-frame count from the host's update(), not from our 50 ms samples
    const flips = last.rev - start.reversals;
    const tail = samples.filter((s) => s.t > 7000);
    const drift = Math.max(...tail.map((s) => Math.abs(s.p[2] - last.p[2])));
    if (sz - last.p[2] < 0.3) problems.push('player did not walk forward');
    if (flips > 0) problems.push('displacement reversed along the stick axis (' + flips + ' frames)');
    if (drift > 0.02) problems.push('player still moving after 7 s');
    if (Math.abs(last.p[1] - sy) > 0.02) problems.push('y off the floor');
    if (last.calls !== calls0) problems.push('host placed the player during the walk');
    if (last.off !== 0) problems.push('offNav != 0');
    if (WORLD === 'koshakan' && Math.abs(last.p[2] - -0.44) > 0.2) problems.push('did not stop at the bed foot (z ' + last.p[2] + ')');
  }
  const verdict = { ok: problems.length === 0, reason: problems, passages: start.passages, xrBlocked: (start.passages ?? []).filter((d) => !d.xrOk), spawn: [sx, sy, sz], end: samples.at(-1) };
  return finish(verdict, problems.length ? 1 : 0);
}

// X4 doors: the runner holds the stick forward. A stub sim on localhost takes POST /event (the host posts
// `touch` there when the page has ?sim=/dreamer.sim). Closed leaf: the player stays >= 0.4 m from it; open leaf:
// the player ends >= 1.5 m past the door (tolerance 10 cm). A held press (2 s) must give exactly one door_touch,
// and the touch must reach the sim with the same id.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function doors(frameOrPage, page, start) {
  const t = await appFrame(page, frameOrPage);
  const problems = [];
  const xrBlocked = [];
  const sim = [];
  await page.route('**/event', (route) => {
    if (route.request().method() === 'POST') {
      try { sim.push(JSON.parse(route.request().postData() ?? 'null')); } catch { /* not json */ }
    }
    return route.fulfill({ status: 200, body: '{}' });
  });
  const api = await t.evaluate(() => ({ open: typeof window.__dreamerXr.openDoor, close: typeof window.__dreamerXr.closeDoor, stage: typeof window.__dreamerXr.stageAtDoor, press: typeof window.__dreamerXr.pressDoor, ev: Array.isArray(window.__dreamerXr.doorEvents), ids: window.__dreamerXr.doorIds }));
  if (api.open !== 'function' || api.close !== 'function' || api.stage !== 'function' || api.press !== 'function' || !api.ev || !api.ids?.length) {
    return finish({ ok: false, reason: ['host has no door api'], api }, 1);
  }
  const id = api.ids[0];
  // closed: stage 1.5 m before the leaf, walk 6 s
  await t.evaluate((i) => { window.__dreamerXr.closeDoor(i); }, id);
  await sleep(1000);
  const closed = await t.evaluate(async (i) => { const x = window.__dreamerXr; x.stageAtDoor(i, 1.5, false); await new Promise((r) => setTimeout(r, 6000)); return x.distToDoor(i); }, id);
  if (!(closed >= 0.4)) problems.push('closed door let the player to ' + closed + ' m');
  // open: stage again, open, wait 1 s, walk 6 s, the player must be >= 1.5 m past the door
  const passed = await t.evaluate(async (i) => { const x = window.__dreamerXr; x.stageAtDoor(i, 1.5, true); x.openDoor(i); await new Promise((r) => setTimeout(r, 1000)); await new Promise((r) => setTimeout(r, 6000)); return x.signedPastDoor(i); }, id);
  // F11: the IWSDK capsule is 1.0 m wide; a door narrower than that (passage.xrOk false) cannot let the player
  // through in the locomotor whatever the leaf does. Reported as xrBlocked (like X3), not as a leaf failure.
  const narrow = (start.passages ?? []).some((d) => d.id === id && !d.xrOk);
  if (!(passed >= 1.5 - 0.1)) {
    // an open door that does not let the player through is a failure, narrow or not
    problems.push('open door: player is ' + passed + ' m past it, need >= 1.4' + (narrow ? ' (door narrower than the 1.0 m capsule, F11)' : ''));
  }
  // press held 2 s: exactly one door_touch for the id, and one touch on the sim with the same id
  const n0 = await t.evaluate(() => window.__dreamerXr.doorEvents.length);
  await t.evaluate(async (i) => { await window.__dreamerXr.pressDoor(i, 2000); }, id);
  await sleep(300);
  const ev = await t.evaluate((n) => window.__dreamerXr.doorEvents.slice(n), n0);
  if (ev.length !== 1 || ev[0] !== id) problems.push('door_touch events: ' + JSON.stringify(ev));
  const touches = sim.filter((m) => m && m.type === 'touch' && m.object === id);
  if (touches.length !== 1) problems.push('sim touch messages: ' + JSON.stringify(sim));
  return finish({ ok: problems.length === 0, reason: problems, xrBlocked, id, closed, passed, events: ev, sim }, problems.length ? 1 : 0);
}
