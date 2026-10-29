import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/check.js";
import { demoFlat } from "./helpers/scene.js";
import { sceneAssets, type AssetRef } from "../src/assets/run.js";
import { fakeGlb, fakePng } from "../src/assets/providers/fake.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dreamer-"));
}

function refs(): AssetRef[] {
  return sceneAssets(runCheck(demoFlat()).ctx.scene);
}

/** Puts a fake cached file for every referenced asset but those in `skip`. */
function fillCache(dir: string, skip: string[] = []): string {
  for (const a of refs()) {
    if (skip.includes(a.id)) continue;
    if (a.kind === "object") writeFileSync(join(dir, `${a.key}.glb`), fakeGlb());
    else writeFileSync(join(dir, `${a.key}.png`), fakePng(4, 4, [120, 90, 60], a.kind === "decal"));
  }
  return dir;
}

interface Built {
  dist: string;
  meshes: Map<string, any>;
  build: any;
}

function build(out: string, cache: string): Built {
  const r = spawnSync(
    "node",
    ["--import", "tsx", "bin/dreamer.ts", "build", DEMO, "--out", out, "--assets", "cache", "--cache", cache],
    { cwd: ENGINE, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
  const geo = JSON.parse(readFileSync(join(out, "geometry.json"), "utf-8"));
  return {
    dist: out,
    meshes: new Map((geo.meshes as any[]).map((m) => [String(m.id), m])),
    build: JSON.parse(readFileSync(join(out, "build.json"), "utf-8")),
  };
}

describe("build with cached assets", () => {
  it("test_scale_from_size", () => {
    // fakeGlb spans y 2..4, so every normalized asset is 2 m tall
    const b = build(join(tmp(), "dist"), fillCache(tmp()));
    const vase = b.meshes.get("vase");
    expect(typeof vase.glb).toBe("string");
    expect(vase.scale).toBeCloseTo(0.2, 6);
    expect(vase.glbPos[1]).toBeCloseTo(0.75, 6);
    expect(b.meshes.get("lamp").glbPos[1]).toBeCloseTo(2.8, 6);
  });

  it("test_missing_glb_stub", () => {
    const b = build(join(tmp(), "dist"), fillCache(tmp(), ["p_sofa"]));
    expect(b.meshes.get("sofa").glb).toBe(undefined);
    expect(typeof b.meshes.get("chairs.0").glb).toBe("string");
    expect(b.build.assets.missing).toContain("p_sofa");
  });

  it("test_rebuild_cache_under_10s", () => {
    const out = join(tmp(), "dist");
    const cache = fillCache(tmp());
    build(out, cache);
    expect(build(out, cache).build.seconds).toBeLessThan(10);
  }, 60000);
});
