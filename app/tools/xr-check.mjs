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
  else if (Math.abs(px - sx) > 0.05 || Math.abs(pz - sz) > 0.05 || Math.abs(py - sy) > 0.02) problems.push('player not on spawn');
  if (problems.length) return finish({ ok: false, reason: problems, report }, 1);
  return finish({ ok: true, report }, 0);
}
