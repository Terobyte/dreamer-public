import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { launch, serve, type Served, closeBrowser } from "./serve.js";
import { demoFlat, patched } from "../helpers/scene.js";
import { runCheck } from "../../src/check.js";
import { sceneAssets } from "../../src/assets/run.js";
import { fakeGlb, fakePng } from "../../src/assets/providers/fake.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));

function build(scenePath: string): { dist: string; meshes: number } {
  const dist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
  const r = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      "bin/dreamer.ts",
      "build",
      scenePath,
      "--out",
      dist,
      "--assets",
      "none",
      "--cache",
      mkdtempSync(join(tmpdir(), "dreamer-cache-")),
    ],
    { cwd: ENGINE, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
  const meshes = JSON.parse(readFileSync(join(dist, "geometry.json"), "utf-8")).meshes.length;
  return { dist, meshes };
}

let browser: Browser;
let site: Served;
let dist: string;
let meshes: number;

async function open(query: string): Promise<{ page: Page; consoleErrors: string[]; pageErrors: string[] }> {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(site.url + query, { timeout: 90000 });
  return { page, consoleErrors, pageErrors };
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction("window.__ready === true", null, { timeout: 90_000 });
}

describe("page", () => {
  beforeAll(async () => {
    dist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
    const r = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "bin/dreamer.ts",
        "build",
        "../specs/examples/demo-flat.scene.json",
        "--out",
        dist,
        "--assets",
        "none",
        "--cache",
        mkdtempSync(join(tmpdir(), "dreamer-cache-")),
      ],
      { cwd: ENGINE, encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
    meshes = JSON.parse(readFileSync(join(dist, "geometry.json"), "utf-8")).meshes.length;
    site = await serve(dist);
    browser = await launch();
  }, 90000);

  afterAll(async () => {
    await closeBrowser(browser);
    await site?.close();
  });

  it("test_page_ready", async () => {
    const { page, consoleErrors, pageErrors } = await open("");
    await ready(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate("window.__dreamer.meshCount()")).toBe(meshes);
    await page.close();
  }, 90000);

  it("test_cam_param", async () => {
    const { page, consoleErrors, pageErrors } = await open("?cam=door");
    await ready(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    const cam = (await page.evaluate("window.__dreamer.camera()")) as {
      pos: number[];
      dir: number[];
      fov: number;
    };
    [0, 1.6, 4.6].forEach((v, i) => expect(cam.pos[i]).toBeCloseTo(v, 6));
    const d = [0, -0.4, -6.6];
    const n = Math.hypot(...d);
    d.forEach((v, i) => expect(cam.dir[i]).toBeCloseTo(v / n, 6));
    expect(cam.fov).toBeCloseTo(70, 6);
    await page.close();

    const bad = await open("?cam=nope");
    await ready(bad.page);
    expect(bad.consoleErrors.length).toBe(1);
    expect(bad.pageErrors).toEqual([]);
    expect(await bad.page.evaluate("document.querySelector('#msg')?.textContent")).toContain("nope");
    await bad.page.close();
  }, 90000);

  it("test_walk_collision", async () => {
    const { page } = await open("?walk=1");
    await ready(page);
    const run = async (x: number, z: number, n: number, dx: number, dz: number): Promise<number[]> =>
      (await page.evaluate(
        ([sx, sz, steps, mx, mz]: number[]) => {
          const d = (window as never as { __dreamer: any }).__dreamer;
          d.teleport(sx, sz);
          for (let i = 0; i < steps; i++) d.tryMove(mx, mz);
          return d.pos();
        },
        [x, z, n, dx, dz],
      )) as number[];

    expect((await run(0, 10, 200, 0, -0.05))[2]).toBeLessThan(3.9);
    expect((await run(0.3, 10, 200, 0, -0.05))[2]).toBeGreaterThanOrEqual(4.25);
    expect((await run(-1, 10, 200, 0, -0.05))[2]).toBeGreaterThanOrEqual(4.25);
    expect((await run(-2.5, 1.5, 40, -0.05, 0))[0]).toBeGreaterThanOrEqual(-2.79);
    await page.close();
  }, 90000);

  it("test_mesh_count_ignores_id_collisions", async () => {
    // Д5's id charset and the global id uniqueness check together make a
    // real scene unable to forge a prop id equal to a generated mesh id
    // (those always carry `:` or `.`), so the collision is injected
    // directly into geometry.json instead: the runtime must still count
    // every mesh (see F6: meshCount must not be derived from an ID-keyed
    // map)
    const built = build(join(ENGINE, "../specs/examples/demo-flat.scene.json"));
    const geoPath = join(built.dist, "geometry.json");
    const geo = JSON.parse(readFileSync(geoPath, "utf-8"));
    geo.meshes.push({ ...geo.meshes[0] });
    writeFileSync(geoPath, JSON.stringify(geo));
    const collisionSite = await serve(built.dist);
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.goto(collisionSite.url, { timeout: 90000 });
    await ready(page);
    expect(await page.evaluate("window.__dreamer.meshCount()")).toBe(geo.meshes.length);
    await page.close();
    await collisionSite.close();
  }, 90000);

  it("test_decal_label_texture_srgb", async () => {
    const { page } = await open("");
    await ready(page);
    const info = (await page.evaluate("window.__dreamer.inspect('decal.0')")) as {
      hasMap: boolean;
      mapColorSpace: string | null;
    };
    expect(info.hasMap).toBe(true);
    expect(info.mapColorSpace).toBe("srgb");
    await page.close();
  }, 90000);

  it("test_cache_texture_rendered_not_placeholder", async () => {
    // F3: a material/decal with a cached asset must load the real file,
    // not the coloured placeholder or the decal label canvas
    const scene = runCheck(demoFlat()).ctx.scene;
    const refs = sceneAssets(scene);
    const cacheDir = mkdtempSync(join(tmpdir(), "dreamer-cache-"));
    for (const a of refs) {
      if (a.kind === "object") writeFileSync(join(cacheDir, `${a.key}.glb`), fakeGlb());
      else writeFileSync(join(cacheDir, `${a.key}.png`), fakePng(4, 4, [120, 90, 60], a.kind === "decal"));
    }
    const scenePath = join(mkdtempSync(join(tmpdir(), "dreamer-scene-")), "scene.json");
    writeFileSync(scenePath, JSON.stringify(demoFlat()));
    const cacheDist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
    const r = spawnSync(
      "node",
      ["--import", "tsx", "bin/dreamer.ts", "build", scenePath, "--out", cacheDist, "--assets", "cache", "--cache", cacheDir],
      { cwd: ENGINE, encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
    const cacheSite = await serve(cacheDist);
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    await page.goto(cacheSite.url, { timeout: 90000 });
    await ready(page);
    expect(consoleErrors).toEqual([]);
    const info = (await page.evaluate("window.__dreamer.inspect('decal.0')")) as {
      hasMap: boolean;
      mapWidth: number | null;
    };
    expect(info.hasMap).toBe(true);
    expect(info.mapWidth).toBe(4);
    await page.close();
    await cacheSite.close();
  }, 90000);

  it("test_prop_glb_rendered", async () => {
    // F7: a prop with a cached GLB must render the real model, not the
    // OBB placeholder box
    const scene = runCheck(demoFlat()).ctx.scene;
    const refs = sceneAssets(scene);
    const cacheDir = mkdtempSync(join(tmpdir(), "dreamer-cache-"));
    for (const a of refs) {
      if (a.kind === "object") writeFileSync(join(cacheDir, `${a.key}.glb`), fakeGlb());
      else writeFileSync(join(cacheDir, `${a.key}.png`), fakePng(4, 4, [120, 90, 60], a.kind === "decal"));
    }
    const scenePath = join(mkdtempSync(join(tmpdir(), "dreamer-scene-")), "scene.json");
    writeFileSync(scenePath, JSON.stringify(demoFlat()));
    const cacheDist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
    const r = spawnSync(
      "node",
      ["--import", "tsx", "bin/dreamer.ts", "build", scenePath, "--out", cacheDist, "--assets", "cache", "--cache", cacheDir],
      { cwd: ENGINE, encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
    const cacheSite = await serve(cacheDist);
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    await page.goto(cacheSite.url, { timeout: 90000 });
    await ready(page);
    expect(consoleErrors).toEqual([]);
    const info = (await page.evaluate("window.__dreamer.inspect('table')")) as { type: string };
    expect(info.type).toBe("Group");
    await page.close();
    await cacheSite.close();
  }, 90000);

  it("test_walk_height", async () => {
    const { page } = await open("?walk=1");
    await ready(page);
    for (const z of [2, 8]) {
      const p = (await page.evaluate(`window.__dreamer.teleport(0, ${z})`)) as number[];
      expect(p[1]).toBeCloseTo(1.6, 6);
      expect(((await page.evaluate("window.__dreamer.pos()")) as number[])[1]).toBeCloseTo(1.6, 6);
    }
    await page.close();
  }, 90000);
});
