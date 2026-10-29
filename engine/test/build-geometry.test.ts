import { describe, it, expect, beforeAll } from "vitest";
import { runCheck } from "../src/check.js";
import { buildGeometry, materialTable, meshBBox } from "../src/build/geometry.js";
import { grayOf } from "../src/build/color.js";
import type { Geometry, Mesh, Light, Camera } from "../src/build/geometry.js";
import { axisPoly, uOfPoint, intervalMeshes } from "../src/build/walls.js";
import type { WallRoom } from "../src/build/walls.js";
import { boxMesh } from "../src/build/beams.js";
import type { Interval } from "../src/plan/merge.js";
import type { OpeningGeo } from "../src/openings/resolve.js";
import { demoFlat } from "./helpers/scene.js";

const WALLISH = new Set(["wall", "band"]);

function unionBBox(ms: Mesh[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of ms) {
    const b = meshBBox(m);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], b.min[i]);
      max[i] = Math.max(max[i], b.max[i]);
    }
  }
  return { min, max };
}

/** meshes whose every vertex sits on the plane z = `z` */
function onPlaneZ(g: Geometry, z: number, kinds = WALLISH): Mesh[] {
  return g.meshes.filter((m) => {
    if (!kinds.has(m.kind)) return false;
    for (let i = 2; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i] - z) > 1e-6) return false;
    }
    return true;
  });
}

/** is (x, y) inside any triangle of `ms` projected onto the XY plane */
function coveredXY(ms: Mesh[], x: number, y: number): Mesh | null {
  for (const m of ms) {
    for (let t = 0; t < m.indices.length; t += 3) {
      const p = [0, 1, 2].map((k) => {
        const i = m.indices[t + k] * 3;
        return [m.positions[i], m.positions[i + 1]];
      });
      const d = (a: number[], b: number[], c: number[]): number =>
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const d0 = d(p[0], p[1], [x, y]);
      const d1 = d(p[1], p[2], [x, y]);
      const d2 = d(p[2], p[0], [x, y]);
      const neg = d0 < -1e-9 || d1 < -1e-9 || d2 < -1e-9;
      const pos = d0 > 1e-9 || d1 > 1e-9 || d2 > 1e-9;
      if (!(neg && pos)) return m;
    }
  }
  return null;
}

function byId(g: Geometry, prefix: string): Mesh[] {
  return g.meshes.filter((m) => m.id.startsWith(prefix));
}

describe("build geometry", () => {
  let g: Geometry;

  beforeAll(() => {
    const { report, ctx } = runCheck(demoFlat());
    expect(report.errors).toEqual([]);
    g = buildGeometry(ctx);
  });

  it("test_floor_bbox", () => {
    const hall = meshBBox(g.meshes.find((m) => m.id === "hall:floor")!);
    expect(hall.min[0]).toBeCloseTo(-2, 6);
    expect(hall.max[0]).toBeCloseTo(2, 6);
    expect(hall.min[2]).toBeCloseTo(4, 6);
    expect(hall.max[2]).toBeCloseTo(12, 6);
    expect(hall.min[1]).toBeCloseTo(0, 6);
    expect(hall.max[1]).toBeCloseTo(0, 6);
    const living = meshBBox(g.meshes.find((m) => m.id === "living:floor")!);
    expect(living.min[0]).toBeCloseTo(-4, 6);
    expect(living.max[0]).toBeCloseTo(4, 6);
    expect(living.min[2]).toBeCloseTo(-5.6, 6);
    expect(living.max[2]).toBeCloseTo(4, 6);
    const hc = meshBBox(g.meshes.find((m) => m.id === "hall:ceiling")!);
    expect(hc.min[1]).toBeCloseTo(3.0, 6);
    expect(hc.max[1]).toBeCloseTo(3.0, 6);
    const lc = meshBBox(g.meshes.find((m) => m.id === "living:ceiling")!);
    expect(lc.min[1]).toBeCloseTo(3.4, 6);
    expect(lc.max[1]).toBeCloseTo(3.4, 6);
  });

  it("test_wall_faces_both_sides", () => {
    const shared = g.meshes.filter((m) => {
      if (!WALLISH.has(m.kind)) return false;
      const b = meshBBox(m);
      return b.min[0] > -2 - 1e-6 && b.max[0] < 2 + 1e-6 && Math.abs(b.min[2] - 4) <= 0.07 && Math.abs(b.max[2] - 4) <= 0.07;
    });
    expect(new Set(shared.map((m) => m.side))).toEqual(new Set(["living", "hall", "$exterior"]));
    const normalsOf = (side: string): number[][] => {
      const out: number[][] = [];
      for (const m of shared.filter((x) => x.side === side)) {
        for (let i = 0; i < m.normals.length; i += 3) {
          out.push(m.normals.slice(i, i + 3));
        }
      }
      return out;
    };
    const expectAll = (vs: number[][], expected: number[]): void => {
      expect(vs.length).toBeGreaterThan(0);
      for (const v of vs) {
        expect(v[0]).toBeCloseTo(expected[0], 6);
        expect(v[1]).toBeCloseTo(expected[1], 6);
        expect(v[2]).toBeCloseTo(expected[2], 6);
      }
    };
    expectAll(normalsOf("living"), [0, 0, -1]);
    expectAll(normalsOf("hall"), [0, 0, 1]);
    expectAll(normalsOf("$exterior"), [0, 0, 1]);
    expect(unionBBox(shared.filter((m) => m.side === "living")).max[1]).toBeCloseTo(3.4, 6);
    expect(unionBBox(shared.filter((m) => m.side === "hall")).max[1]).toBeCloseTo(3.0, 6);
    const ext = unionBBox(shared.filter((m) => m.side === "$exterior"));
    expect(ext.min[1]).toBeCloseTo(3.0, 6);
    expect(ext.max[1]).toBeCloseTo(3.4, 6);

    const stub = g.meshes.filter((m) => {
      if (!WALLISH.has(m.kind)) return false;
      const b = meshBBox(m);
      return b.min[0] > 2 - 1e-6 && b.max[0] < 4 + 1e-6 && Math.abs(b.min[2] - 4) <= 0.07;
    });
    expect(new Set(stub.map((m) => m.side))).toEqual(new Set(["living", "$exterior"]));
    const se = unionBBox(stub.filter((m) => m.side === "$exterior"));
    expect(se.min[1]).toBeCloseTo(0, 6);
    expect(se.max[1]).toBeCloseTo(3.4, 6);
  });

  it("test_door_cut", () => {
    for (const z of [3.94, 4.06]) {
      const ms = onPlaneZ(g, z);
      expect(ms.length).toBeGreaterThan(0);
      expect(coveredXY(ms, 0, 1.0)).toBeNull();
      expect(coveredXY(ms, -1, 1.0)).not.toBeNull();
      const hit = coveredXY(ms, 0, 2.5);
      expect(hit).not.toBeNull();
      expect(hit!.kind).toBe("wall");
      expect(hit!.side).toBe(z < 4 ? "living" : "hall");
    }
    expect(g.meshes.some((m) => m.kind === "reveal")).toBe(true);
  });

  it("test_window_cut_on_arc", () => {
    const arcWall = byId(g, "living#1:").filter((m) => WALLISH.has(m.kind));
    for (const z of [-5.484563, -5.604563]) {
      const ms = arcWall.filter((m) => {
        for (let i = 2; i < m.positions.length; i += 3) {
          if (Math.abs(m.positions[i] - z) > 1e-6) return false;
        }
        return true;
      });
      expect(ms.length).toBeGreaterThan(0);
      expect(coveredXY(ms, 0, 1.5)).toBeNull();
      expect(coveredXY(ms, 0, 0.5)).not.toBeNull();
      expect(coveredXY(ms, 0, 2.5)).not.toBeNull();
    }
    const planeOf: Record<string, number> = { living: -5.484563, $exterior: -5.604563 };
    for (const side of ["living", "$exterior"]) {
      for (const m of byId(g, `living#1:${side}:`).filter((x) => WALLISH.has(x.kind))) {
        for (let i = 0; i < m.positions.length; i += 3) {
          if (Math.abs(m.positions[i]) < 0.8 - 1e-6) {
            expect(m.positions[i + 2]).toBeCloseTo(planeOf[side], 6);
          }
        }
      }
    }
  });

  it("test_bands", () => {
    const wood = g.meshes.filter((m) => m.kind === "band" && m.material === "wood" && m.side === "living");
    expect(wood.length).toBeGreaterThan(0);
    const wb = unionBBox(wood);
    expect(wb.min[1]).toBeCloseTo(0, 6);
    expect(wb.max[1]).toBeCloseTo(0.12, 6);
    const olive = g.meshes.filter((m) => m.kind === "wall" && m.material === "olive" && m.side === "living");
    const ob = unionBBox(olive);
    expect(ob.min[1]).toBeCloseTo(0.12, 6);
    expect(ob.max[1]).toBeCloseTo(3.4, 6);
  });

  it("test_beam", () => {
    const b = meshBBox(g.meshes.find((m) => m.id === "living:beam:0")!);
    expect(b.min[0]).toBeCloseTo(-4, 6);
    expect(b.max[0]).toBeCloseTo(4, 6);
    expect(b.min[2]).toBeCloseTo(-0.125, 6);
    expect(b.max[2]).toBeCloseTo(0.125, 6);
    expect(b.min[1]).toBeCloseTo(3.1, 6);
    expect(b.max[1]).toBeCloseTo(3.4, 6);
  });

  it("test_gray_hash", () => {
    expect(grayOf("olive")).toBe("#8e8e8e");
    expect(grayOf("parquet")).toBe("#818181");
  });

  it("test_winding_matches_normals", () => {
    for (const m of g.meshes) {
      expect(m.normals.length).toBe(m.positions.length);
      expect(m.uvs.length / 2).toBe(m.positions.length / 3);
      const nv = m.positions.length / 3;
      for (const i of m.indices) expect(i).toBeLessThan(nv);
      for (let t = 0; t < m.indices.length; t += 3) {
        const [ia, ib, ic] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const p = (i: number): number[] => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
        const a = p(ia);
        const b = p(ib);
        const c = p(ic);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const n = [m.normals[ia * 3], m.normals[ia * 3 + 1], m.normals[ia * 3 + 2]];
        const dot = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2];
        expect(dot, `${m.id} tri ${t / 3}`).toBeGreaterThan(0);
      }
    }
  });

  it("test_mesh_ids_unique", () => {
    const ids = g.meshes.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("test_materials_table", () => {
    expect(g.materials.olive).toEqual({ color: "#8e8e8e", repeat_m: 2 });
    expect(g.materials.wood.color).toBe("#7a5230");
    for (const k of ["p_sofa", "d_door", "$exterior"]) expect(g.materials[k]).toBeDefined();
  });

  it("test_uv_metres", () => {
    const wall = byId(g, "living#0:living:").filter((m) => m.kind === "wall" && m.material === "olive");
    expect(wall.length).toBeGreaterThan(0);
    const uvRange = (ms: Mesh[]): number[] => {
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (const m of ms) {
        for (let i = 0; i < m.uvs.length; i += 2) {
          u0 = Math.min(u0, m.uvs[i]);
          u1 = Math.max(u1, m.uvs[i]);
          v0 = Math.min(v0, m.uvs[i + 1]);
          v1 = Math.max(v1, m.uvs[i + 1]);
        }
      }
      return [u0, u1, v0, v1];
    };
    const [u0, u1, v0, v1] = uvRange(wall);
    expect(u0).toBeCloseTo(0, 6);
    expect(u1).toBeCloseTo(8, 6);
    expect(v0).toBeCloseTo(0.12, 6);
    expect(v1).toBeCloseTo(3.4, 6);
    const band = byId(g, "living#0:living:").filter((m) => m.kind === "band");
    const [, , bv0, bv1] = uvRange(band);
    expect(bv0).toBeCloseTo(0, 6);
    expect(bv1).toBeCloseTo(0.12, 6);
  });

  it("test_arc_uv_origin_preserved_on_seam_shift", () => {
    // full circle wall whose seam gets moved away from az=0 because an
    // opening straddles it (spec "Проём на дуге" / F3) — u must still read
    // as distance from the original interval.from, not from the moved seam
    // (F9/F11: a sign/wraparound bug left u measured from the moved seam)
    const r = 5;
    const circumference = 2 * Math.PI * r;
    const iv: Interval = {
      from: [0, r],
      to: [0, r],
      arc: { c: [0, 0], r, sweep: 2 * Math.PI },
      sides: [{ room: "r1", edge: 0, m: [0, circumference] }],
      thickness: 0.2,
    };
    const az = 0.1;
    const ends: [[number, number], [number, number]] = [
      [r * Math.sin(-az), r * Math.cos(-az)],
      [r * Math.sin(az), r * Math.cos(az)],
    ];
    const openings = [{ ends }] as unknown as OpeningGeo[];
    const poly = axisPoly(iv, openings);
    const u0 = uOfPoint(poly, ends[0]);
    const u1 = uOfPoint(poly, ends[1]);
    // u is the discretized polyline length from interval.from, not the
    // exact analytic arc length and not measured from any moved seam
    // (F11/F16/F18/F19/F20); values verified against the 0.25 m sampling
    // inserted chord ends no longer lengthen the polyline (r6 F-U drift):
    // was 30.912724 with the other end's insert counted in
    expect(u0).toBeCloseTo(30.912723, 6);
    expect(u1).toBeCloseTo(0.499948, 6);
    void circumference;
    void az;
  });

  it("test_arc_opening_at_zero_keeps_rest_of_wall", () => {
    // F18: an opening edge sitting exactly at az=0 must not swallow nearly
    // the whole circle as a false hole
    const r = 5;
    const iv: Interval = {
      from: [0, r],
      to: [0, r],
      arc: { c: [0, 0], r, sweep: 2 * Math.PI },
      sides: [{ room: "r1", edge: 0, m: [0, 2 * Math.PI * r] }],
      thickness: 0.2,
    };
    const ends: [[number, number], [number, number]] = [
      [r * Math.sin(-0.2), r * Math.cos(-0.2)],
      [0, r],
    ];
    const openings = [{ id: "o", ends, sill: 0, height: 2 }] as unknown as OpeningGeo[];
    const room: WallRoom = { id: "r1", height: 3, normalIn: [0, -1], wallMaterial: "wall", bands: [] };
    const meshes = intervalMeshes(iv, { levelY: 0, openings, caps: { k: 0 }, room: () => room }, () => 0);
    const wallMeshes = meshes.filter((m) => m.kind === "wall" && m.side === "r1");
    // opposite side of the circle (az = π, point (0, -r)) must still have
    // wall vertices nearby, not just the sliver next to the opening
    const nearOpposite = wallMeshes.some((m) =>
      m.positions.some((v, i) => i % 3 === 0 && Math.abs(v) < 0.3 && Math.abs(m.positions[i + 2] + r) < 0.3),
    );
    expect(nearOpposite).toBe(true);
  });

  it("test_arc_reveal_stays_near_opening_chord", () => {
    // F19: reveal jambs/head/sill must stay on the opening's own chord,
    // not drift elsewhere when the circle's u parameter is resolved
    const r = 5;
    const iv: Interval = {
      from: [0, r],
      to: [0, r],
      arc: { c: [0, 0], r, sweep: 2 * Math.PI },
      sides: [{ room: "r1", edge: 0, m: [0, 2 * Math.PI * r] }],
      thickness: 0.2,
    };
    const az = 0.1;
    const ends: [[number, number], [number, number]] = [
      [r * Math.sin(-az), r * Math.cos(-az)],
      [r * Math.sin(az), r * Math.cos(az)],
    ];
    const openings = [{ id: "o", ends, sill: 0, height: 2 }] as unknown as OpeningGeo[];
    const room: WallRoom = { id: "r1", height: 3, normalIn: [0, -1], wallMaterial: "wall", bands: [] };
    const meshes = intervalMeshes(iv, { levelY: 0, openings, caps: { k: 0 }, room: () => room }, () => 0);
    const reveals = meshes.filter((m) => m.kind === "reveal");
    expect(reveals.length).toBeGreaterThan(0);
    for (const m of reveals) {
      const b = meshBBox(m);
      expect(Math.abs(b.min[0])).toBeLessThan(1);
      expect(Math.abs(b.max[0])).toBeLessThan(1);
      expect(b.min[2]).toBeGreaterThan(r - 0.3);
    }
  });

  it("test_arc_two_openings_dont_collide_seams", () => {
    // two openings, one straddling az=0 and one straddling the seam the
    // first shift would move to (az=π) — the seam must land somewhere that
    // avoids both, not blindly jump by π (F12)
    const r = 5;
    const iv: Interval = {
      from: [0, r],
      to: [0, r],
      arc: { c: [0, 0], r, sweep: 2 * Math.PI },
      sides: [{ room: "r1", edge: 0, m: [0, 2 * Math.PI * r] }],
      thickness: 0.2,
    };
    const endsAt = (az: number): [[number, number], [number, number]] => [
      [r * Math.sin(az - 0.1), r * Math.cos(az - 0.1)],
      [r * Math.sin(az + 0.1), r * Math.cos(az + 0.1)],
    ];
    const openings = [{ ends: endsAt(0) }, { ends: endsAt(Math.PI) }] as unknown as OpeningGeo[];
    const poly = axisPoly(iv, openings);
    const n = poly.pts.length;
    // the az=0 opening's own bridge is the wrap gap between the last and
    // first kept point (the az=0 hole sits right on interval.from), the
    // az=π opening's bridge is an ordinary internal segment
    const seg = poly.pts.map((p, i) => {
      const q = poly.pts[(i + 1) % n];
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    });
    // the only segments allowed to be larger than a sample step (~0.25 m)
    // are the two openings' own bridges (chord ≈ 2 r sin(0.1) ≈ 1 m); a
    // seam that collides with the second opening instead eats a whole
    // 9.95 m arc as a fake hole (F12)
    const large = seg.filter((d) => d > 0.3);
    expect(large.length).toBe(2);
    for (const d of large) expect(d).toBeLessThan(1.1);
  });

  it("test_arc_opening_crossing_seam_keeps_wall", () => {
    // F15: when the shifted seam's opening-avoidance logic mishandles an
    // opening that straddles az=0, the wall below the opening disappears
    const r = 5;
    const iv: Interval = {
      from: [0, r],
      to: [0, r],
      arc: { c: [0, 0], r, sweep: 2 * Math.PI },
      sides: [{ room: "r1", edge: 0, m: [0, 2 * Math.PI * r] }],
      thickness: 0.2,
    };
    const az = 0.1;
    const ends: [[number, number], [number, number]] = [
      [-r * Math.sin(az), r * Math.cos(az)],
      [r * Math.sin(az), r * Math.cos(az)],
    ];
    const openings = [{ id: "o", ends, sill: 0, height: 2 }] as unknown as OpeningGeo[];
    const room: WallRoom = { id: "r1", height: 3, normalIn: [0, -1], wallMaterial: "wall", bands: [] };
    const meshes = intervalMeshes(iv, { levelY: 0, openings, caps: { k: 0 }, room: () => room }, () => 0);
    const belowSillVerts = meshes
      .filter((m) => m.kind === "wall")
      .flatMap((m) => m.positions.filter((v, i) => i % 3 === 1 && v < 2));
    expect(belowSillVerts.length).toBeGreaterThan(0);
  });

  describe("full circle openings (host fix r6)", () => {
    const r = 5;
    const iv: Interval = {
      from: [0, r],
      to: [0, r],
      arc: { c: [0, 0], r, sweep: 2 * Math.PI },
      sides: [{ room: "r1", edge: 0, m: [0, 2 * Math.PI * r] }],
      thickness: 0.2,
    };
    const room: WallRoom = { id: "r1", height: 3, normalIn: [0, -1], wallMaterial: "wall", bands: [] };
    const onCircle = (deg: number): [number, number] => [r * Math.sin((deg * Math.PI) / 180), r * Math.cos((deg * Math.PI) / 180)];
    const opening = (azDeg: number, width: number, sill: number, height: number): OpeningGeo => {
      const d = (Math.asin(width / 2 / r) * 180) / Math.PI;
      return { id: "o", ends: [onCircle(azDeg - d), onCircle(azDeg + d)], center: onCircle(azDeg), sill, height } as unknown as OpeningGeo;
    };
    const build = (o: OpeningGeo): Mesh[] =>
      intervalMeshes(iv, { levelY: 0, openings: [o], caps: { k: 0 }, room: () => room }, () => 0);
    // a triangle of `ms` covering (a, b) in the plane picked by `pick`, among triangles passing `keep`
    const covers = (ms: Mesh[], pick: (p: number[]) => [number, number], keep: (p: number[][]) => boolean, a: number, b: number): boolean =>
      ms.some((m) => {
        for (let i = 0; i < m.indices.length; i += 3) {
          const ps = [0, 1, 2].map((k) => m.positions.slice(m.indices[i + k] * 3, m.indices[i + k] * 3 + 3));
          if (!keep(ps)) continue;
          const [p0, p1, p2] = ps.map(pick);
          const s = (q: number[], w: number[], e: number[]): number => (w[0] - q[0]) * (e[1] - q[1]) - (w[1] - q[1]) * (e[0] - q[0]);
          const d0 = s(p0, p1, [a, b]);
          const d1 = s(p1, p2, [a, b]);
          const d2 = s(p2, p0, [a, b]);
          if ((d0 >= -1e-9 && d1 >= -1e-9 && d2 >= -1e-9) || (d0 <= 1e-9 && d1 <= 1e-9 && d2 <= 1e-9)) return true;
        }
        return false;
      });

    it("test_circle_opening_across_seam_keeps_chord_wall_and_cap", () => {
      const ms = build(opening(0, 1, 1, 1));
      const walls = ms.filter((m) => m.kind === "wall");
      const nearChord = (ps: number[][]): boolean => ps.every((p) => p[2] > 4.5);
      const xy = (p: number[]): [number, number] => [p[0], p[1]];
      expect(covers(walls, xy, nearChord, 0, 2.5)).toBe(true);
      expect(covers(walls, xy, nearChord, 0, 0.5)).toBe(true);
      expect(covers(walls, xy, nearChord, 0, 1.5)).toBe(false);
      const caps = ms.filter((m) => m.kind === "cap");
      const xz = (p: number[]): [number, number] => [p[0], p[2]];
      const chordZ = Math.sqrt(r * r - 0.25);
      expect(covers(caps, xz, () => true, 0, chordZ)).toBe(true);
    });

    it("test_circle_half_opening_cuts_its_own_half", () => {
      const ms = build(opening(0, 10, 0, 2)).filter((m) => m.kind === "wall");
      const zs = ms.flatMap((m) => m.positions.filter((_, i) => i % 3 === 2));
      // +Z half replaced by the chord through the centre, -Z half stays on the arc
      expect(zs.some((z) => z > 1)).toBe(false);
      expect(zs.some((z) => z < -4)).toBe(true);
    });

    it("test_circle_u_after_opening_keeps_sampled_distance", () => {
      const o = opening(207.142857, 1, 1, 1);
      const poly = axisPoly(iv, [o]);
      const a = (2 * Math.PI * 75) / 126;
      expect(uOfPoint(poly, [r * Math.sin(a), r * Math.cos(a)])).toBeCloseTo(18.698019, 6);
    });
  });

  it("test_material_asset_id_shadows_prototype_prop", () => {
    // F17: `id in out` matches inherited Object.prototype props like
    // "toString", so a legitimately-named asset falsely collides
    const scene = { materials: {}, assets: { toString: { kind: "prop" } }, style: {} };
    expect(() => materialTable(scene)).not.toThrow();
  });

  it("test_beam_face_uv_meters", () => {
    // F13: a beam's vertical side faces have differing y per vertex, but
    // uv=(x,z) ignores y entirely, so V collapses across the face height
    const y0 = 3.1;
    const y1 = 3.4;
    const m = boxMesh("b", "beam", "wood", "r1", [0, 0], [4, 0], 0.25, y0, y1);
    // long-side face is the 3rd quad (indices 12..17); vertex 12 sits at y0, vertex 14 at y1
    const vOf = (i: number): number => m.uvs[i * 2 + 1];
    expect(m.positions[12 * 3 + 1]).toBeCloseTo(y0, 6);
    expect(m.positions[14 * 3 + 1]).toBeCloseTo(y1, 6);
    expect(Math.abs(vOf(14) - vOf(12))).toBeCloseTo(y1 - y0, 6);
  });

  it("test_material_asset_tile_id_collision", () => {
    // F14: a tile asset sharing an id with a scene material must still be
    // rejected, even though tile-kind assets otherwise skip the material table
    const scene = {
      materials: { stone: { color: "#112233" } },
      assets: { stone: { kind: "tile" } },
      style: { exterior: "#808080" },
    };
    expect(() => materialTable(scene)).toThrow();
  });

  it("test_material_proto_key_preserved", () => {
    // F21: an asset literally named "__proto__" must become its own
    // enumerable material entry, not silently mutate Object.prototype
    const scene = JSON.parse('{"materials":{},"assets":{"__proto__":{"kind":"prop"}},"style":{}}');
    const out = materialTable(scene);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(JSON.stringify(out)).toContain("__proto__");
  });

  it("test_exterior_reserved_material_id_rejected", () => {
    // F22: a scene material named "$exterior" must be rejected, not
    // silently overwritten by the synthetic exterior material
    const scene = { materials: { $exterior: { color: "#112233" } }, assets: {}, style: { exterior: "#808080" } };
    expect(() => materialTable(scene)).toThrow();
  });

  it("test_light_camera_types", () => {
    const hemi: Light = { kind: "hemi", color: "#ffffff", power: 1 };
    const cam: Camera = { id: "c1", pos: [0, 0, 0], fov: 60 };
    expect(hemi.kind).toBe("hemi");
    expect(cam.id).toBe("c1");
  });
});
