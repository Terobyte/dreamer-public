import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";
import type { Mesh } from "../src/build/geometry.js";
import { intervalMeshes } from "../src/build/walls.js";
import type { WallRoom } from "../src/build/walls.js";
import type { Interval } from "../src/plan/merge.js";
import type { OpeningGeo } from "../src/openings/resolve.js";
import { parseScene } from "../src/schema/parse.js";
import { demoFlat, patched } from "./helpers/scene.js";

const WALLISH = new Set(["wall", "band"]);

/** is `p` on (within `tol` of) some triangle of `ms` */
function onSurface(ms: Mesh[], p: number[], tol: number): boolean {
  for (const m of ms) {
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => m.positions.slice(m.indices[i + k] * 3, m.indices[i + k] * 3 + 3));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(n[0], n[1], n[2]);
      if (l < 1e-12) continue;
      const nn = n.map((x) => x / l);
      const d = (p[0] - a[0]) * nn[0] + (p[1] - a[1]) * nn[1] + (p[2] - a[2]) * nn[2];
      if (Math.abs(d) > tol) continue;
      const q = [0, 1, 2].map((k) => p[k] - nn[k] * d);
      // barycentric containment of `q` in triangle a,b,c
      const dot = (x: number[], y: number[]): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
      const w = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
      const uu = dot(u, u);
      const uv = dot(u, v);
      const vv = dot(v, v);
      const wu = dot(w, u);
      const wv = dot(w, v);
      const den = uu * vv - uv * uv;
      if (Math.abs(den) < 1e-12) continue;
      const s = (vv * wu - uv * wv) / den;
      const t = (uu * wv - uv * wu) / den;
      if (s >= -1e-6 && t >= -1e-6 && s + t <= 1 + 1e-6) return true;
    }
  }
  return false;
}

describe("phase 2 debt", () => {
  it("test_arc_negative_sweep_opening", () => {
    // Д2: an arc edge swept the other way (bulge < 0) must cut its opening
    // just the same — no test covered a negative sweep before
    const scene = patched([{ op: "replace", path: "/rooms/0/shape/1/2/bulge", value: -0.4 }]);
    const { report, ctx } = runCheck(scene as never);
    expect(report.errors).toEqual([]);
    const sea = ctx.openings!.find((o) => o.id === "sea")!;
    const geo = buildGeometry(ctx);
    const faces = geo.meshes.filter((m) => WALLISH.has(m.kind) && m.id.startsWith("living#1:"));
    expect(faces.length).toBeGreaterThan(0);
    const at = (y: number): number[] => [sea.center[0], y, sea.center[1]];
    // the window spans 1.0..2.0, so its own height is open and the wall
    // below the sill is solid (tol covers the half thickness plus the
    // sagitta between the arc axis and the opening's flat chord panel)
    expect(onSurface(faces, at(1.5), 0.25)).toBe(false);
    expect(onSurface(faces, at(0.5), 0.25)).toBe(true);
  });

  it("test_circle_reveal_normals_across_seam", () => {
    // Д3: reveals of an opening crossing the seam took their frame from the
    // arc after u[0] instead of the chord closing the chain
    const r = 4;
    const iv: Interval = {
      level: "L0",
      from: [0, r],
      to: [0, r],
      arc: { c: [0, 0], r, sweep: 2 * Math.PI },
      sides: [{ room: "r1", edge: 0, m: [0, 2 * Math.PI * r] }],
      thickness: 0.2,
    } as unknown as Interval;
    const room: WallRoom = { id: "r1", height: 3, normalIn: [0, -1], wallMaterial: "wall", bands: [] };
    const onCircle = (deg: number): [number, number] => [
      r * Math.sin((deg * Math.PI) / 180),
      r * Math.cos((deg * Math.PI) / 180),
    ];
    const d = (Math.asin(0.5 / r) * 180) / Math.PI;
    const o = { id: "o", ends: [onCircle(-d), onCircle(d)], center: onCircle(0), sill: 1, height: 1 } as unknown as OpeningGeo;
    const ms = intervalMeshes(iv, { levelY: 0, openings: [o], caps: { k: 0 }, room: () => room }, () => 0).filter(
      (m) => m.kind === "reveal",
    );
    const ny = (m: Mesh): number => m.normals[1];
    const centroid = (m: Mesh): number[] => {
      const c = [0, 0, 0];
      const n = m.positions.length / 3;
      for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) c[k] += m.positions[i + k] / n;
      return c;
    };
    const sill = ms.filter((m) => ny(m) > 0.99);
    const head = ms.filter((m) => ny(m) < -0.99);
    const jambs = ms.filter((m) => Math.abs(ny(m)) < 1e-9);
    expect(sill).toHaveLength(1);
    expect(head).toHaveLength(1);
    expect(jambs).toHaveLength(2);
    expect(centroid(sill[0])[1]).toBeCloseTo(1, 6);
    expect(centroid(head[0])[1]).toBeCloseTo(2, 6);
    for (const j of jambs) {
      const c = centroid(j);
      const toCenter = [o.center[0] - c[0], o.center[1] - c[2]];
      expect(j.normals[0] * toCenter[0] + j.normals[2] * toCenter[1]).toBeGreaterThan(0);
    }
  });

  it("test_id_charset", () => {
    // Д5: an author id may not look like a generated mesh id (`cap:0`)
    const { report } = runCheck(patched([{ op: "replace", path: "/props/4/id", value: "cap:0" }]) as never);
    expect(report.errors.map((e) => e.code)).toEqual(["SCHEMA_TYPE"]);
    expect(report.errors[0].path).toBe("/props/4/id");
    expect(runCheck(demoFlat() as never).report.errors).toEqual([]);
    const { raw } = parseScene(
      readFileSync(new URL("../../specs/examples/demo.scene.json", import.meta.url), "utf-8"),
    );
    expect(runCheck(raw).report.errors.map((e) => e.path)).toEqual(["/stairs"]);
  });
});
