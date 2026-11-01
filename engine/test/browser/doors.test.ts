import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { launch, serve, closeBrowser, type Served } from "./serve.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const HAS_CHROMIUM = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_CHROMIUM)("doors in the browser", () => {
  let served: Served;
  let browser: Awaited<ReturnType<typeof launch>>;

  beforeAll(async () => {
    const dist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
    const r = spawnSync(
      "node",
      ["--import", "tsx", "bin/dreamer.ts", "build", "../specs/examples/demo-flat.scene.json", "--out", dist, "--assets", "none", "--cache", mkdtempSync(join(tmpdir(), "dreamer-cache-"))],
      { cwd: ENGINE, encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(`build failed: ${r.stderr}${r.stdout}`);
    served = await serve(dist);
    browser = await launch();
  }, 90_000);

  afterAll(async () => {
    await served?.close();
    if (browser) await closeBrowser(browser);
  });

  it("test_browser_open_turns_90_and_lock_touch", async () => {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as any).__touches = [];
      window.addEventListener("door_touch", (e: any) => (window as any).__touches.push(e.detail?.id));
    });
    await page.goto(served.url);
    await page.waitForFunction(() => (window as any).__ready === true);
    const sweep = await page.evaluate(() => (window as any).__dreamer.door("front").sweepDeg());
    // demo-flat builds the front leaf open: close it first, so open() below
    // runs the real 0.6 s turn instead of accepting an already-open leaf
    await page.evaluate(() => (window as any).__dreamer.door("front").close());
    await page.waitForFunction(() => Math.abs((window as any).__dreamer.door("front").angle()) < 1, undefined, { timeout: 90_000 });
    await page.evaluate(() => (window as any).__dreamer.door("front").open());
    // contract: the leaf turns 90° in 0.6 s of real time; a loaded machine (parallel
    // vitest workers) drops frames, so wait for the angle with headroom, not a fixed 0.75 s
    await page.waitForFunction(
      (s) => Math.abs((window as any).__dreamer.door("front").angle() - Math.sign(s) * 90) <= 5,
      sweep, { timeout: 3000 },
    ).catch(() => {});
    const a = await page.evaluate(() => (window as any).__dreamer.door("front").angle());
    expect(Math.abs(a - Math.sign(sweep) * 90)).toBeLessThanOrEqual(5);

    await page.evaluate(() => (window as any).__dreamer.door("front").lock());
    await page.waitForFunction(() => Math.abs((window as any).__dreamer.door("front").angle()) < 0.01, undefined, { timeout: 90_000 });
    const closed = await page.evaluate(() => {
      const e = (window as any).__dreamer;
      e.teleport(0, 5);
      e.look(180);
      return e.door("front").angle();
    });
    await page.waitForFunction(() => (window as any).__touches.length > 0, undefined, { timeout: 5000 });
    const after = await page.evaluate(() => ({ angle: (window as any).__dreamer.door("front").angle(), touches: (window as any).__touches }));
    expect(after.touches).toContain("front");
    // the close tween can still be settling (4e-14 -> -0), so "did not open" is a tolerance, not equality
    expect(Math.abs(after.angle - closed)).toBeLessThan(0.01);
    await page.close();
  }, 60_000);
});
