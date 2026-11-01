import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DirectionalLight, Scene } from "three";
import { patched, demoFlat } from "./helpers/scene.js";
import { addSceneLights } from "../src/build/lights.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));

function build(scene: unknown): any {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
  const path = join(dir, "s.scene.json");
  writeFileSync(path, JSON.stringify(scene));
  const dist = join(dir, "dist");
  const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", "build", path, "--out", dist, "--assets", "none"], {
    cwd: ENGINE,
    encoding: "utf-8",
  });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return JSON.parse(readFileSync(join(dist, "build.json"), "utf-8"));
}

const SUN = { kind: "sun", dir: [1, 2, 0.5], intensity: 2.5, castShadow: true };

describe("sun", () => {
  it("test_sun_in_build_json", () => {
    const b = build(patched([{ op: "add", path: "/lights/-", value: SUN }]));
    const suns = (b.lights as any[]).filter((l) => l.kind === "sun");
    expect(suns).toEqual([SUN]);
    const none = build(demoFlat());
    expect((none.lights as any[]).filter((l) => l.kind === "sun")).toEqual([]);
  }, 90000);

  it("test_runtime_directional_light", () => {
    const scene = new Scene();
    addSceneLights(scene, { lights: [SUN], style: { ambient: 1 } });
    const dl = scene.children.filter((c) => c instanceof DirectionalLight) as DirectionalLight[];
    expect(dl.length).toBe(1);
    expect(dl[0].intensity).toBeCloseTo(2.5, 6);
    expect(dl[0].castShadow).toBe(true);
    const d = dl[0].position.clone().sub(dl[0].target.position).normalize();
    const n = Math.hypot(1, 2, 0.5);
    expect(d.x).toBeCloseTo(1 / n, 6);
    expect(d.y).toBeCloseTo(2 / n, 6);
    expect(d.z).toBeCloseTo(0.5 / n, 6);

    // no sun: the flat ambient as before, no directional light
    const flat = new Scene();
    addSceneLights(flat, { lights: [], style: { ambient: 1 } });
    expect(flat.children.some((c) => c instanceof DirectionalLight)).toBe(false);
    expect(flat.children.length).toBe(1);
  });
});
