import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { runCheck } from "../src/check.js";
import { demoFlat, patched } from "./helpers/scene.js";
import { promptFor, sizeFor } from "../src/assets/templates.js";
import { cacheKey } from "../src/assets/cache.js";
import { cutWhite } from "../src/assets/alpha.js";
import { runAssets, sceneAssets, type AssetRef } from "../src/assets/run.js";
import { FakeImageProvider, FakeObjectProvider, fakeGlb, fakePng } from "../src/assets/providers/fake.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", ...args], { cwd: ENGINE, encoding: "utf-8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dreamer-"));
}

/** The scene as the compiler sees it: validated, with `aspect` defaulted. */
function validated(scene: unknown): any {
  return runCheck(scene).ctx.scene;
}

/** Puts a fake cached file for every referenced asset but those in `skip`. */
function fillCache(dir: string, refs: AssetRef[], skip: string[] = []): void {
  for (const a of refs) {
    if (skip.includes(a.id)) continue;
    if (a.kind === "object") writeFileSync(join(dir, `${a.key}.glb`), fakeGlb());
    else writeFileSync(join(dir, `${a.key}.png`), fakePng(4, 4, [120, 90, 60], a.kind === "decal"));
  }
}

describe("assets without generation", () => {
  it("test_prompt_templates", () => {
    const o = promptFor("object", "a vase");
    expect(o.startsWith("single object, front view facing the camera, whole object, plain white background, no shadow")).toBe(true);
    expect(o.endsWith(". a vase")).toBe(true);
    const t = promptFor("tile", "a vase");
    expect(t.startsWith("seamless tileable texture, orthographic front view, flat even lighting, no shadows, no perspective, the pattern repeats with no visible edges")).toBe(true);
    expect(t.endsWith(". a vase")).toBe(true);
    const d = promptFor("decal", "a vase");
    expect(d.startsWith("orthographic front view, flat even lighting, centred, filling the frame, plain flat white background")).toBe(true);
    expect(d.endsWith(". a vase")).toBe(true);
  });

  it("test_size_for", () => {
    expect(sizeFor("1:1")).toBe("1024x1024");
    expect(sizeFor("2:1")).toBe("2048x1024");
    expect(sizeFor("1:2")).toBe("1024x2048");
    expect(sizeFor("4:3")).toBe("1024x1024");
  });

  it("test_cache_key_stable", () => {
    expect(cacheKey("object", "a vase")).toBe(cacheKey("object", "a vase"));
    expect(cacheKey("tile", "wood", "1:1")).not.toBe(cacheKey("tile", "wood", "2:1"));
    const base = new Map(sceneAssets(validated(demoFlat())).map((a) => [a.id, a.key]));
    const taller = new Map(
      sceneAssets(validated(patched([{ op: "replace", path: "/props/0/size/h", value: 1.2 }]))).map((a) => [a.id, a.key]),
    );
    expect(taller.get("p_table")).toBe(base.get("p_table"));
  });

  it("test_cache_mode_no_calls", async () => {
    const scene = validated(demoFlat());
    const refs = sceneAssets(scene);
    expect(refs.length).toBe(10);
    const dir = tmp();
    fillCache(dir, refs);
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider();
    const rep = await runAssets(scene, { mode: "cache", cacheDir: dir, image, object });
    expect([image.calls.length, object.calls.length]).toEqual([0, 0]);
    expect(rep.used.slice().sort()).toEqual(refs.map((a) => a.id).sort());
    expect([rep.missing, rep.cents]).toEqual([[], 0]);
  });

  it("test_decal_alpha", () => {
    const png = new PNG({ width: 16, height: 16 });
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        const border = x < 4 || y < 4 || x > 11 || y > 11;
        const rgb = border ? [255, 255, 255] : [200, 50, 50];
        png.data[i] = rgb[0];
        png.data[i + 1] = rgb[1];
        png.data[i + 2] = rgb[2];
        png.data[i + 3] = 255;
      }
    }
    const cut = PNG.sync.read(cutWhite(PNG.sync.write(png)));
    const alpha = (x: number, y: number): number => cut.data[(y * 16 + x) * 4 + 3];
    expect([alpha(0, 0), alpha(4, 8), alpha(8, 8)]).toEqual([0, 128, 255]);
  });

  it("test_live_runs_check_first", () => {
    const bad = join(tmp(), "bad.scene.json");
    writeFileSync(bad, JSON.stringify({ version: 0 }));
    const outDir = join(tmp(), "dist");
    const r = cli(["build", bad, "--out", outDir, "--assets", "live", "--max-dollars", "1", "--cache", tmp()]);
    expect(r.status).toBe(1);
    expect(existsSync(outDir)).toBe(false);
    const report = JSON.parse(r.stdout);
    expect(report.errors.length).toBeGreaterThan(0);
  });
});

describe("assets from cache through the cli", () => {
  let out: string;
  let run: { status: number; stdout: string; stderr: string };
  let build: any;

  beforeAll(() => {
    const refs = sceneAssets(validated(demoFlat()));
    const cache = tmp();
    fillCache(cache, refs, ["p_sofa"]);
    out = join(tmp(), "dist");
    run = cli(["build", DEMO, "--out", out, "--assets", "cache", "--cache", cache]);
    build = existsSync(join(out, "build.json")) ? JSON.parse(readFileSync(join(out, "build.json"), "utf-8")) : null;
  }, 120000);

  it("test_missing_asset_falls_back", () => {
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(build.assets.missing).toEqual(["p_sofa"]);
    expect(build.assets.used.length).toBe(9);
    expect(build.warnings.some((w: string) => w.includes("p_sofa"))).toBe(true);
  });

  it("test_cache_assets_written_and_linked", () => {
    expect(existsSync(join(out, "assets", "t_wall.png"))).toBe(true);
    expect(existsSync(join(out, "assets", "d_sea.png"))).toBe(true);
    expect(existsSync(join(out, "assets", "p_table.glb"))).toBe(true);
    expect(existsSync(join(out, "assets", "p_sofa.glb"))).toBe(false);
    const geometry = JSON.parse(readFileSync(join(out, "geometry.json"), "utf-8"));
    expect(geometry.materials.olive.map).toBe("assets/t_wall.png");
    expect(geometry.materials.d_sea.map).toBe("assets/d_sea.png");
  });
});

describe("asset id safety", () => {
  function sceneWithTileId(tileId: string): any {
    const base = demoFlat() as any;
    return {
      ...base,
      materials: { ...base.materials, olive: { ...base.materials.olive, tile: tileId } },
      assets: { ...base.assets, [tileId]: { kind: "tile", prompt: "weird" } },
    };
  }

  it("test_asset_id_path_traversal_blocked", () => {
    const scene = sceneWithTileId("../../sentinel");
    const refs = sceneAssets(validated(scene));
    const cache = tmp();
    fillCache(cache, refs);
    const scenePath = join(tmp(), "scene.json");
    writeFileSync(scenePath, JSON.stringify(scene));
    const outParent = tmp();
    const outDir = join(outParent, "dist");
    const sentinel = join(outParent, "sentinel.png");
    writeFileSync(sentinel, "untouched");
    const r = cli(["build", scenePath, "--out", outDir, "--assets", "cache", "--cache", cache]);
    expect(r.status).not.toBe(0);
    expect(readFileSync(sentinel, "utf-8")).toBe("untouched");
  });

  it("test_asset_id_nested_path_allowed", () => {
    const scene = sceneWithTileId("tile/custom");
    const refs = sceneAssets(validated(scene));
    const cache = tmp();
    fillCache(cache, refs);
    const scenePath = join(tmp(), "scene.json");
    writeFileSync(scenePath, JSON.stringify(scene));
    const outDir = join(tmp(), "dist");
    const r = cli(["build", scenePath, "--out", outDir, "--assets", "cache", "--cache", cache]);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(existsSync(join(outDir, "assets", "tile", "custom.png"))).toBe(true);
    const geometry = JSON.parse(readFileSync(join(outDir, "geometry.json"), "utf-8"));
    expect(geometry.materials.olive.map).toBe("assets/tile/custom.png");
  });

  it("test_asset_id_url_encoded", () => {
    // F9: an id with a URL-special character must not change which part of
    // the URL the browser treats as path vs. fragment/query
    const scene = sceneWithTileId("tile#custom");
    const refs = sceneAssets(validated(scene));
    const cache = tmp();
    fillCache(cache, refs);
    const scenePath = join(tmp(), "scene.json");
    writeFileSync(scenePath, JSON.stringify(scene));
    const outDir = join(tmp(), "dist");
    const r = cli(["build", scenePath, "--out", outDir, "--assets", "cache", "--cache", cache]);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(existsSync(join(outDir, "assets", "tile#custom.png"))).toBe(true);
    const geometry = JSON.parse(readFileSync(join(outDir, "geometry.json"), "utf-8"));
    expect(geometry.materials.olive.map).toBe("assets/tile%23custom.png");
  });

  it("test_asset_id_dunder_proto_safe", () => {
    const scene = sceneWithTileId("__proto__");
    const refs = sceneAssets(validated(scene));
    const cache = tmp();
    fillCache(cache, refs);
    const scenePath = join(tmp(), "scene.json");
    writeFileSync(scenePath, JSON.stringify(scene));
    const outDir = join(tmp(), "dist");
    const r = cli(["build", scenePath, "--out", outDir, "--assets", "cache", "--cache", cache]);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(existsSync(join(outDir, "assets", "__proto__.png"))).toBe(true);
    const geometry = JSON.parse(readFileSync(join(outDir, "geometry.json"), "utf-8"));
    expect(geometry.materials.olive.map).toBe("assets/__proto__.png");
  });
});
