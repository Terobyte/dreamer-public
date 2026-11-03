import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { launch, serve, type Served, closeBrowser } from "./serve.js";
import { demoFlat, patched } from "../helpers/scene.js";
import { fakePng } from "../../src/assets/providers/fake.js";
import { runShots, SHOTS_DEFAULTS } from "../../src/build/shots.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));

/** Builds a scene object into a fresh dist/ via the real CLI; building writes files, it never opens a browser. */
function build(scene: unknown, name = "demo-flat"): { dist: string; scenePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
  const scenePath = join(dir, `${name}.scene.json`);
  writeFileSync(scenePath, JSON.stringify(scene));
  const dist = join(dir, "dist");
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
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}${r.stdout}`);
  return { dist, scenePath };
}

/** Width and height straight out of the PNG IHDR, no image library needed. */
function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

let browser: Browser;

describe("dreamer shots", () => {
  beforeAll(async () => {
    browser = await launch();
  }, 30000);

  afterAll(async () => {
    await closeBrowser(browser);
  });

  async function shots(dist: string, opts = SHOTS_DEFAULTS): Promise<{ status: number; served: Served }> {
    const served = await serve(dist);
    const status = await runShots(dist, opts, { browser, served });
    return { status, served };
  }

  it("writes a png per camera and a sheet", { timeout: 120000 }, async () => {
    const { dist } = build(demoFlat());
    const { status, served } = await shots(dist);
    await served.close();
    expect(status).toBe(0);
    expect(pngSize(join(dist, "shots", "door.png"))).toEqual({ w: 1280, h: 720 });
    expect(existsSync(join(dist, "sheet.png"))).toBe(true);
  });

  it("fails with the camera id when the page never gets ready", { timeout: 120000 }, async () => {
    const { dist } = build(demoFlat());
    // A runtime that never sets `window.__ready`: the ready wait below can
    // only end via the injected clock, so the test measures no wall-clock.
    const copy = join(mkdtempSync(join(tmpdir(), "dreamer-stub-")), "dist");
    cpSync(dist, copy, { recursive: true });
    writeFileSync(join(copy, "runtime.js"), "window.__stub = true;\n");
    const served = await serve(copy);
    // Fake clock: records the deadline, fires only when the test advances it.
    const pending: Array<{ cb: () => void; ms: number }> = [];
    const timers = {
      setTimeout: (cb: () => void, ms: number): unknown => {
        pending.push({ cb, ms });
        return pending.length;
      },
      clearTimeout: (_id: unknown): void => {},
    };
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    const run = runShots(copy, { ...SHOTS_DEFAULTS, readyTimeoutMs: 2000 }, { browser, served, timers });
    try {
      for (let i = 0; i < 10000 && pending.length === 0; i++) await new Promise((r) => setImmediate(r));
      // The deadline comes from the option, the moment of firing from the test.
      expect(pending.length).toBeGreaterThan(0);
      const seen = pending.map((p) => p.ms);
      for (const p of pending.splice(0)) p.cb();
      expect(await run).toBe(2);
      expect(seen).toEqual([2000]);
      expect(errs.join("\n")).toContain("door");
    } finally {
      console.error = orig;
      await served.close();
    }
  });

  it("puts the ref next to the shot on the sheet", { timeout: 120000 }, async () => {
    const withRef = patched([{ op: "add", path: "/cameras/0/ref", value: "myref.png" }]);
    const dir = mkdtempSync(join(tmpdir(), "dreamer-ref-"));
    const scenePath = join(dir, "demo-flat.scene.json");
    writeFileSync(scenePath, JSON.stringify(withRef));
    writeFileSync(join(dir, "myref.png"), fakePng(8, 8, [10, 20, 30]));
    const dist = join(dir, "dist");
    const b = spawnSync(
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
    if (b.status !== 0) throw new Error(`build failed: ${b.stderr}`);
    expect(existsSync(join(dist, "refs", "0-myref.png"))).toBe(true);

    const { status, served } = await shots(dist);
    await served.close();
    expect(status).toBe(0);
    expect(readFileSync(join(dist, "sheet.html"), "utf-8")).toContain('src="refs/0-myref.png"');

    const plain = build(demoFlat()).dist;
    const r2 = await shots(plain);
    await r2.served.close();
    expect(r2.status).toBe(0);
    const plainSheet = readFileSync(join(plain, "sheet.html"), "utf-8");
    expect(plainSheet).toContain("нет ref");
  });

  it("does not escape the shots directory for a camera id with path segments", { timeout: 120000 }, async () => {
    const evil = patched([{ op: "replace", path: "/cameras/0/id", value: "../../escape" }]);
    const { dist } = build(evil);
    const { status, served } = await shots(dist);
    await served.close();
    expect(status).toBe(0);
    const outside = join(dist, "..", "..", "escape.png");
    expect(existsSync(outside)).toBe(false);
    const entries = readdirSync(join(dist, "shots"));
    expect(entries.length).toBe(1);
    for (const name of entries) {
      expect(name.includes("/")).toBe(false);
    }
  });

  it("escapes a camera id with markup on the sheet instead of rendering it", { timeout: 120000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "dreamer-xss-"));
    writeFileSync(join(dir, "myref.png"), fakePng(8, 8, [10, 20, 30]));
    const evil = patched([
      { op: "replace", path: "/cameras/0/id", value: '"><script>window.__pwned=1</script>' },
      { op: "add", path: "/cameras/0/ref", value: "myref.png" },
    ]);
    const scenePath = join(dir, "demo-flat.scene.json");
    writeFileSync(scenePath, JSON.stringify(evil));
    const dist = join(dir, "dist");
    const b = spawnSync(
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
    if (b.status !== 0) throw new Error(`build failed: ${b.stderr}`);
    const { status, served } = await shots(dist);
    await served.close();
    expect(status).toBe(0);
    const sheet = readFileSync(join(dist, "sheet.html"), "utf-8");
    expect(sheet).not.toContain("<script>window.__pwned=1</script>");
  });

  it(
    "keeps shot and ref images resolvable when the camera id and ref filename contain url-reserved characters",
    { timeout: 120000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dreamer-reserved-"));
      const refName = "my#ref%20two.png";
      writeFileSync(join(dir, refName), fakePng(8, 8, [1, 2, 3]));
      const withReserved = patched([
        { op: "replace", path: "/cameras/0/id", value: "room/left" },
        { op: "add", path: "/cameras/0/ref", value: refName },
      ]);
      const scenePath = join(dir, "demo-flat.scene.json");
      writeFileSync(scenePath, JSON.stringify(withReserved));
      const dist = join(dir, "dist");
      const b = spawnSync(
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
      if (b.status !== 0) throw new Error(`build failed: ${b.stderr}`);
      const { status, served } = await shots(dist);
      expect(status).toBe(0);
      const sheet = readFileSync(join(dist, "sheet.html"), "utf-8");
      const hrefs = [...sheet.matchAll(/src="([^"]+)"/g)].map((m) => m[1]!);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        const res = await fetch(served.url + href);
        expect(res.status, href).toBe(200);
      }
      await served.close();
    },
  );

  it("renders only the screenshot and the caption for a camera without a ref", { timeout: 120000 }, async () => {
    const { dist } = build(demoFlat());
    const { status, served } = await shots(dist);
    await served.close();
    expect(status).toBe(0);
    const sheet = readFileSync(join(dist, "sheet.html"), "utf-8");
    expect((sheet.match(/class="cell"/g) ?? []).length).toBe(1);
    expect(sheet).not.toContain(">ref<");
    expect(sheet).not.toContain(">door<");
  });

  it("gives colliding camera ids distinct screenshots on a correctly matched sheet", { timeout: 120000 }, async () => {
    const evil = patched([
      { op: "replace", path: "/cameras/0/id", value: "room/left" },
      { op: "add", path: "/cameras/1", value: { id: "room_left", pos: [0, 1.6, -3.4], look: [0, 1.2, 0], fov: 70 } },
    ]);
    const { dist } = build(evil);
    const { status, served } = await shots(dist);
    await served.close();
    expect(status).toBe(0);

    const files = readdirSync(join(dist, "shots"));
    expect(files.length).toBe(2);
    expect(new Set(files).size).toBe(2);

    const sheet = readFileSync(join(dist, "sheet.html"), "utf-8");
    const hrefs = [...sheet.matchAll(/src="(shots\/[^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs).toEqual(["shots/room_left-0.png", "shots/room_left-1.png"]);
    for (const href of hrefs) {
      expect(existsSync(join(dist, href))).toBe(true);
    }
  });

  it("keeps a camera id that is already a legal filename", { timeout: 120000 }, async () => {
    const named = patched([{ op: "replace", path: "/cameras/0/id", value: "front.view" }]);
    const { dist } = build(named);
    const { status, served } = await shots(dist);
    expect(status).toBe(0);
    expect(existsSync(join(dist, "shots", "front.view.png"))).toBe(true);
    const sheet = readFileSync(join(dist, "sheet.html"), "utf-8");
    const hrefs = [...sheet.matchAll(/src="(shots\/[^"]+)"/g)].map((m) => m[1]!);
    for (const href of hrefs) {
      const res = await fetch(served.url + href);
      expect(res.status, href).toBe(200);
    }
    await served.close();
  });
});
