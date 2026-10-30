import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { Browser } from "playwright";
import { launch, serve, type Served, closeBrowser } from "./serve.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../../../specs/examples/yard-house.scene.json", import.meta.url));

function build(scene: any): string {
  const tmp = mkdtempSync(join(tmpdir(), "dreamer-outdoor-"));
  const path = join(tmp, "scene.json");
  writeFileSync(path, JSON.stringify(scene));
  const dist = join(tmp, "dist");
  const r = spawnSync(
    "node",
    ["--import", "tsx", "bin/dreamer.ts", "build", path, "--out", dist, "--assets", "none", "--cache", join(tmp, "cache")],
    { cwd: ENGINE, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
  return dist;
}

function withCams(outdoor: boolean): any {
  const s = JSON.parse(readFileSync(EXAMPLE, "utf-8"));
  if (!outdoor) delete s.outdoor;
  s.cameras = [
    // in the yard, back to the house, looking at the horizon
    { id: "cam_yard", pos: [0, 1.6, -8], look: [0, 1.6, -60] },
    // in the study (no windows), looking up at the ceiling corner
    { id: "cam_study", pos: [0, 1.6, 9], look: [3, 2.8, 11.5] },
  ];
  return s;
}

let browser: Browser | null = null;
const sites: Served[] = [];

async function shot(dist: string, cam: string): Promise<PNG> {
  const site = await serve(dist);
  sites.push(site);
  const page = await browser!.newPage({ deviceScaleFactor: 1, viewport: { width: 320, height: 240 } });
  await page.goto(`${site.url}?cam=${cam}`);
  await page.waitForFunction("window.__ready === true", null, { timeout: 20000 });
  const png = PNG.sync.read(await page.screenshot());
  await page.close();
  return png;
}

const rowMean = (p: PNG, y0: number, y1: number): number[] => {
  const s = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      s[0] += p.data[i];
      s[1] += p.data[i + 1];
      s[2] += p.data[i + 2];
      n++;
    }
  return s.map((v) => v / n);
};

/** Pixels that read as the sky stand-in: clearly bluer than they are red. */
const skyish = (p: PNG): number => {
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 2] > p.data[i] + 25) n++;
  return n;
};

describe("В2 outdoor page", () => {
  beforeAll(async () => {
    try {
      browser = await launch();
    } catch {
      browser = null; // no Chromium on this machine: the tests below skip
    }
  }, 60000);

  afterAll(async () => {
    for (const s of sites) await s.close();
    await closeBrowser(browser ?? undefined);
  });

  it("yard camera at the horizon: sky on top, ground below, no pure black", async (t) => {
    if (!browser) return t.skip();
    const p = await shot(build(withCams(true)), "cam_yard");
    const top = rowMean(p, 0, Math.floor(p.height * 0.2));
    const bottom = rowMean(p, Math.floor(p.height * 0.8), p.height);
    expect(Math.abs(top[0] - bottom[0]) + Math.abs(top[1] - bottom[1]) + Math.abs(top[2] - bottom[2])).toBeGreaterThan(30);
    let black = 0;
    for (let i = 0; i < p.data.length; i += 4) if (p.data[i] === 0 && p.data[i + 1] === 0 && p.data[i + 2] === 0) black++;
    expect(black).toBe(0);
  }, 90000);

  it("study camera never sees the dome through the ceiling", async (t) => {
    if (!browser) return t.skip();
    const withSky = await shot(build(withCams(true)), "cam_study");
    const without = await shot(build(withCams(false)), "cam_study");
    // same make-up of the frame: the dome adds no sky-coloured pixels indoors
    // (a few bluish edge pixels exist without any sky at all)
    const area = without.width * without.height;
    expect(skyish(without)).toBeLessThan(area * 0.001);
    expect(skyish(withSky)).toBeLessThanOrEqual(skyish(without) + area * 0.001);
  }, 120000);
});
