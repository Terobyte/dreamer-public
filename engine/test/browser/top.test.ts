import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { Browser } from "playwright";
import { launch, serve, closeBrowser } from "./serve.js";
import { demoFlat } from "../helpers/scene.js";
import { runShots, SHOTS_DEFAULTS } from "../../src/build/shots.js";
import { readMarks } from "../helpers/timing.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

function sceneFile(scene: unknown): { dir: string; scenePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
  const scenePath = join(dir, "demo-flat.scene.json");
  writeFileSync(scenePath, JSON.stringify(scene));
  return { dir, scenePath };
}

/**
 * Points Playwright's browser cache at an empty directory, so any attempt to
 * launch chromium fails loudly (no installed browser found) instead of
 * silently succeeding. Used to prove `check`/`build` never open a browser: if
 * they did, they would blow up under this env (F2, F3).
 */
const NO_CHROMIUM_ENV = { PLAYWRIGHT_BROWSERS_PATH: mkdtempSync(join(tmpdir(), "dreamer-no-browsers-")) };

function cli(
  args: string[],
  env?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", ...args], {
    cwd: ENGINE,
    encoding: "utf-8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function build(scene: unknown): string {
  const { dir, scenePath } = sceneFile(scene);
  const dist = join(dir, "dist");
  const r = cli([
    "build",
    scenePath,
    "--out",
    dist,
    "--assets",
    "none",
    "--cache",
    mkdtempSync(join(tmpdir(), "dreamer-cache-")),
  ]);
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}${r.stdout}`);
  return dist;
}

/** Root `width`/`height` of the plan svg, the size its png has to match. */
function svgSize(file: string): { w: number; h: number } {
  const text = readFileSync(file, "utf-8");
  const w = /<svg[^>]*\swidth="([\d.]+)"/.exec(text);
  const h = /<svg[^>]*\sheight="([\d.]+)"/.exec(text);
  if (!w || !h) throw new Error("svg root has no width/height");
  return { w: Number(w[1]), h: Number(h[1]) };
}

let browser: Browser;

describe("top.png", () => {
  beforeAll(async () => {
    browser = await launch();
  }, 30000);

  afterAll(async () => {
    await closeBrowser(browser);
  });

  it("test_top_png: shots renders the plan svg into dist/top.png", { timeout: 60000 }, async () => {
    const dist = build(demoFlat());
    const served = await serve(dist);
    const status = await runShots(dist, SHOTS_DEFAULTS, { browser, served });
    await served.close();
    expect(status).toBe(0);

    const png = join(dist, "top.png");
    expect(existsSync(png)).toBe(true);
    const want = svgSize(join(dist, "top.svg"));
    const img = PNG.sync.read(readFileSync(png));
    expect(img.width).toBe(Math.floor(want.w));
    expect(img.height).toBe(Math.floor(want.h));

    const first = img.data.subarray(0, 4).join(",");
    let differs = false;
    for (let i = 4; i < img.data.length && !differs; i += 4) {
      if (img.data.subarray(i, i + 4).join(",") !== first) differs = true;
    }
    expect(differs).toBe(true);
  });

  it("test_check_no_browser: check and build never make a top.png", { timeout: 90_000 }, () => {
    const reportDir = mkdtempSync(join(tmpdir(), "dreamer-report-"));
    // Timed from the start of the `check` command (every module already
    // loaded) to the moment this process has its result: a browser launch
    // would land inside that window; node+tsx startup, which a loaded machine
    // stretches past a second on its own, does not (debt Д8).
    const timing = join(mkdtempSync(join(tmpdir(), "dreamer-timing-")), "marks.jsonl");
    const r = cli(["check", DEMO, "--report", join(reportDir, "demo-flat.check.json")], {
      ...NO_CHROMIUM_ENV,
      DREAMER_TIMING_FILE: timing,
    });
    const done = Date.now();
    const started = readMarks(timing).find((m) => m.mark === "main");
    expect(started, "check wrote its main mark").toBeDefined();
    const seconds = (done - started!.t) / 1000;
    expect(r.status).toBe(0);
    expect(existsSync(join(reportDir, "demo-flat.top.svg"))).toBe(true);
    expect(existsSync(join(reportDir, "demo-flat.top.png"))).toBe(false);
    expect(existsSync(join(reportDir, "top.png"))).toBe(false);
    expect(seconds).toBeLessThan(3);

    const { dir, scenePath } = sceneFile(demoFlat());
    const dist = join(dir, "dist");
    const buildResult = cli(
      ["build", scenePath, "--out", dist, "--assets", "none", "--cache", mkdtempSync(join(tmpdir(), "dreamer-cache-"))],
      NO_CHROMIUM_ENV,
    );
    expect(buildResult.status).toBe(0);
    expect(existsSync(join(dist, "top.svg"))).toBe(true);
    expect(existsSync(join(dist, "top.png"))).toBe(false);
  });

  it("test_shots_missing_top_svg: shots fails loudly when top.svg is absent", { timeout: 90_000 }, () => {
    const dist = build(demoFlat());
    unlinkSync(join(dist, "top.svg"));
    const r = cli(["shots", dist]);
    expect(r.status).not.toBe(0);
  });
});
