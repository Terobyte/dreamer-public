import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { launch, serve, closeBrowser, type Served } from "./browser/serve.js";
import { demoFlat } from "./helpers/scene.js";
import { runCheck } from "../src/check.js";
import { sceneAssets } from "../src/assets/run.js";
import { fakeGlb, fakePng } from "../src/assets/providers/fake.js";

const ENGINE = fileURLToPath(new URL("../", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";
let browser: Browser;
let site: Served;

function fullCache(): string {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-b36-cache-"));
  for (const a of sceneAssets(runCheck(demoFlat()).ctx.scene)) {
    if (a.kind === "object") writeFileSync(join(dir, `${a.key}.glb`), fakeGlb());
    else writeFileSync(join(dir, `${a.key}.png`), fakePng(8, 8, [120, 90, 60], a.kind === "decal"));
  }
  return dir;
}

describe("B36 runtime readiness after a failed GLB", () => {
  beforeAll(async () => {
    const dist = join(mkdtempSync(join(tmpdir(), "dreamer-b36-")), "dist");
    const built = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", "build", DEMO,
      "--out", dist, "--assets", "cache", "--cache", fullCache()], { cwd: ENGINE, encoding: "utf-8" });
    if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`);
    const geo = JSON.parse(readFileSync(join(dist, "geometry.json"), "utf8"));
    const mesh = geo.meshes.find((m: any) => typeof m.glb === "string");
    if (!mesh) throw new Error("B36 fixture has no GLB mesh");
    const badAsset = join(dist, mesh.glb);
    if (existsSync(badAsset)) rmSync(badAsset);
    browser = await launch();
    site = await serve(dist);
  }, 30000);
  afterAll(async () => {
    await closeBrowser(browser);
    await site?.close();
  });

  it("logs the failed prop GLB and still sets __ready", async () => {
    const page = await browser.newPage();
    const warnings: string[] = [];
    page.on("console", (msg) => { if (msg.type() === "warning") warnings.push(msg.text()); });
    try {
      await page.goto(site.url);
      // wait for the event, not a fixed time: the gate runs under load
      const ready = await page.waitForFunction(() => (window as any).__ready === true, null,
        { timeout: 8000 }).then(() => true, () => false);
      expect(ready,
        "B36: failed GLB left __ready false and shots cannot start").toBe(true);
      expect(warnings.some((w) => /GLB failed/.test(w)),
        "B36: failed prop GLB must be logged and replaced with a box").toBe(true);
    } finally {
      await page.close();
    }
  }, 25000);
});
