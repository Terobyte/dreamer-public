import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { launch, serve, type Served } from "./serve.js";
import { patched } from "../helpers/scene.js";

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
  await page.goto(site.url + query);
  return { page, consoleErrors, pageErrors };
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction("window.__ready === true", null, { timeout: 15000 });
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
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it("test_page_ready", async () => {
    const { page, consoleErrors, pageErrors } = await open("");
    await ready(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate("window.__dreamer.meshCount()")).toBe(meshes);
    await page.close();
  }, 30000);

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
  }, 30000);

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
  }, 30000);

  it("test_mesh_count_ignores_id_collisions", async () => {
    // a prop id colliding with a generated wall cap must not make the
    // runtime undercount meshes (see F6: meshCount must not be derived
    // from an ID-keyed map)
    const dir = mkdtempSync(join(tmpdir(), "dreamer-scene-"));
    const scenePath = join(dir, "collision.scene.json");
    writeFileSync(scenePath, JSON.stringify(patched([{ op: "replace", path: "/props/2/id", value: "cap:0" }])));
    const built = build(scenePath);
    const collisionSite = await serve(built.dist);
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.goto(collisionSite.url);
    await ready(page);
    expect(await page.evaluate("window.__dreamer.meshCount()")).toBe(built.meshes);
    await page.close();
    await collisionSite.close();
  }, 30000);

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
  }, 30000);

  it("test_walk_height", async () => {
    const { page } = await open("?walk=1");
    await ready(page);
    for (const z of [2, 8]) {
      const p = (await page.evaluate(`window.__dreamer.teleport(0, ${z})`)) as number[];
      expect(p[1]).toBeCloseTo(1.6, 6);
      expect(((await page.evaluate("window.__dreamer.pos()")) as number[])[1]).toBeCloseTo(1.6, 6);
    }
    await page.close();
  }, 30000);
});
