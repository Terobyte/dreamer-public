import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patched } from "./helpers/scene.js";
import { scatterEntries, scatterPoints } from "../src/build/scatter.js";
import { validate } from "../src/schema/validate.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const dist = (p: number[]): number => Math.hypot(p[0], p[1]);

describe("scatter", () => {
  it("test_scatter_min_spacing", () => {
    const { points } = scatterPoints({ assets: ["tuft"], count: 200, area: [0, 0, 40, 40], seed: 3 });
    expect(points.length).toBe(200);
    let min = Infinity;
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) min = Math.min(min, Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z));
    expect(min).toBeGreaterThanOrEqual(0.3);
  });

  it("test_scatter_empty_and_fewer", () => {
    expect(() => scatterPoints({ assets: ["t"], count: 5, area: [0, 0, 1, 1], seed: 1, avoid: [[0.5, 0.5]] })).toThrow(/SCATTER_EMPTY/);
    const r = scatterPoints({ assets: ["t"], count: 50, area: [0, 0, 3, 3], seed: 1 });
    expect(r.points.length).toBeGreaterThan(0);
    expect(r.points.length).toBeLessThan(50);
    expect(r.warnings.join(" ")).toContain("SCATTER_FEWER");
  });

  it("test_scatter_tiny_hole_1e10", () => {
    const x = 1.053, z = 1.047, d = 0.8000000001;
    const avoid = Array.from({ length: 72 }, (_, i) => [x + d * Math.cos((i * Math.PI) / 36), z + d * Math.sin((i * Math.PI) / 36)]) as [number, number][];
    const { points } = scatterPoints({ assets: ["t"], count: 1, area: [0, 0, 2, 2], seed: 1, avoid });
    expect(points.length).toBe(1);
  });

  it("test_scatter_cross_set_spacing", () => {
    const { entries } = scatterEntries({
      scatter: [
        { assets: ["t"], count: 1, area: [0, 0, 3, 3], seed: 1 },
        { assets: ["t"], count: 1, area: [0, 0, 3, 3], seed: 1 },
      ],
    });
    const t = entries[0].transforms;
    expect(t.length).toBe(2);
    expect(Math.hypot(t[0][0] - t[1][0], t[0][2] - t[1][2])).toBeGreaterThanOrEqual(0.3);
  });

  it("test_scatter_merged_per_asset", () => {
    const { entries } = scatterEntries({
      scatter: [
        { assets: ["tuft"], count: 10, area: [0, 0, 10, 10], seed: 1 },
        { assets: ["tuft"], count: 10, area: [0, 0, 10, 10], seed: 2 },
      ],
    });
    expect(entries.length).toBe(1);
    expect(entries[0].asset).toBe("tuft");
    expect(entries[0].count).toBe(20);
  });

  it("test_scatter_ref_kind", () => {
    const scene = patched([
      { op: "add", path: "/assets/ground", value: { kind: "tile", prompt: "grass" } },
      { op: "add", path: "/scatter", value: [{ assets: ["ground"], count: 5, area: [0, 0, 5, 5], seed: 1 }] },
    ]);
    const kinds = validate(scene).issues.filter((i) => i.code === "REF_KIND" && i.path.startsWith("/scatter/"));
    expect(kinds.length).toBe(1);
  });

  it("test_scatter_build_json", () => {
    const area = [-10, -10, 10, 10];
    const avoid = [[0, 0], [3, 3], [-4, 2]];
    const scene = patched([
      { op: "add", path: "/assets/tuft", value: { kind: "object", prompt: "a small grass tuft" } },
      { op: "add", path: "/scatter", value: [{ assets: ["tuft"], count: 200, area, seed: 7, avoid }] },
    ]);
    expect(validate(scene).issues.filter((i) => i.code.startsWith("SCHEMA")).length).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    const path = join(dir, "s.scene.json");
    writeFileSync(path, JSON.stringify(scene));
    const run = (name: string) => {
      const out = join(dir, name);
      const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", "build", path, "--out", out, "--assets", "none"], { cwd: ENGINE, encoding: "utf-8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      return JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
    };
    const a = run("a");
    const b = run("b");
    expect(a.scatter.length).toBe(1);
    expect(a.scatter[0].asset).toBe("tuft");
    const tr = a.scatter[0].transforms as number[][];
    expect(tr.length).toBe(200);
    expect(b.scatter[0].transforms).toEqual(tr);
    for (const t of tr) {
      expect(t[0]).toBeGreaterThanOrEqual(-10);
      expect(t[0]).toBeLessThanOrEqual(10);
      expect(t[2]).toBeGreaterThanOrEqual(-10);
      expect(t[2]).toBeLessThanOrEqual(10);
      for (const v of avoid) expect(dist([t[0] - v[0], t[2] - v[1]])).toBeGreaterThanOrEqual(0.8);
    }
  }, 90000);

  it("test_scatter_fewer_in_build_json", () => {
    const scene = patched([
      { op: "add", path: "/assets/tuft", value: { kind: "object", prompt: "a small grass tuft" } },
      { op: "add", path: "/scatter", value: [{ assets: ["tuft"], count: 50, area: [0, 0, 3, 3], seed: 1 }] },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    const path = join(dir, "s.scene.json");
    writeFileSync(path, JSON.stringify(scene));
    const out = join(dir, "out");
    const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", "build", path, "--out", out, "--assets", "none"], { cwd: ENGINE, encoding: "utf-8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
    expect(build.warnings.join(" ")).toContain("SCATTER_FEWER");
  }, 90000);
});
