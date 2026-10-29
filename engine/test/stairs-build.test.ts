import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";
import { buildGeometry, meshBBox } from "../src/build/geometry.js";
import type { Geometry, Mesh } from "../src/build/geometry.js";
import { footprintsOverlap } from "../src/build/slab.js";

const demoUrl = new URL("../../specs/examples/demo.scene.json", import.meta.url);

function demo(): any {
  return JSON.parse(readFileSync(demoUrl, "utf-8"));
}

type P2 = [number, number];

/** XZ-projected triangles of `m`, dropping the vertical (degenerate) ones */
function trisXZ(m: Mesh): P2[][] {
  const out: P2[][] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => {
      const i = m.indices[t + k] * 3;
      return [m.positions[i], m.positions[i + 2]] as P2;
    });
    const a2 = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    if (Math.abs(a2) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

function coveredXZ(m: Mesh, x: number, z: number): boolean {
  const side = (a: P2, b: P2): number => (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
  for (const p of trisXZ(m)) {
    const d = [side(p[0], p[1]), side(p[1], p[2]), side(p[2], p[0])];
    if (d.every((v) => v >= -1e-9) || d.every((v) => v <= 1e-9)) return true;
  }
  return false;
}

function areaXZ(m: Mesh): number {
  let s = 0;
  for (const p of trisXZ(m)) {
    s += Math.abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])) / 2;
  }
  return s;
}

function byId(g: Geometry, id: string): Mesh {
  const m = g.meshes.find((x) => x.id === id);
  expect(m, `mesh ${id}`).toBeDefined();
  return m!;
}

describe("stairs build", () => {
  let g: Geometry;
  beforeAll(() => {
    const { report, ctx } = runCheck(demo());
    expect(report.errors).toEqual([]);
    g = buildGeometry(ctx);
  });

  it("test_stair_meshes", () => {
    const steps = g.meshes.filter((m) => /^up:step:\d+$/.test(m.id));
    expect(steps).toHaveLength(20);
    expect(steps.every((m) => m.kind === "step")).toBe(true);

    const top = meshBBox(byId(g, "up:step:20"));
    expect(top.min[2]).toBeCloseTo(6.0, 6);
    expect(top.max[2]).toBeCloseTo(6.28, 6);
    expect(top.min[1]).toBeCloseTo(0, 6);
    expect(top.max[1]).toBeCloseTo(3.428571, 6);

    const slab = byId(g, "loft:slab");
    expect(slab.kind).toBe("slab");
    const sb = meshBBox(slab);
    expect(sb.min[1]).toBeCloseTo(3.0, 6);
    expect(sb.max[1]).toBeCloseTo(3.6, 6);

    const three = [slab, byId(g, "loft:floor"), byId(g, "hall:ceiling")];
    for (const m of three) expect(coveredXZ(m, 1.4, 8.0), `${m.id} at the cut`).toBe(false);
    for (const m of three) expect(coveredXZ(m, -1, 8.0), `${m.id} beside the cut`).toBe(true);
  });

  it("test_stair_rail_sides", () => {
    const left = byId(g, "up:rail:left");
    expect(left.kind).toBe("rail");
    const b = meshBBox(left);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0.95, 6);
    expect(g.meshes.some((m) => m.id === "up:rail:right")).toBe(false);
  });

  it("test_cut_rails_skip_exit", () => {
    const cut = g.meshes.filter((m) => /^up:rail:cut:\d+$/.test(m.id));
    expect(cut).toHaveLength(3);
    const mids = cut.map((m) => {
      const b = meshBBox(m);
      return { x: (b.min[0] + b.max[0]) / 2, z: (b.min[2] + b.max[2]) / 2, b };
    });
    expect(mids.filter((m) => Math.abs(m.x - 0.95) < 1e-6)).toHaveLength(1);
    expect(mids.filter((m) => Math.abs(m.x - 1.85) < 1e-6)).toHaveLength(1);
    expect(mids.filter((m) => Math.abs(m.z - 10.246667) < 1e-6)).toHaveLength(1);

    // the way off the flight stays clear
    for (const m of g.meshes.filter((x) => x.kind === "rail")) {
      const b = meshBBox(m);
      const blocks =
        b.min[2] <= 6.0 + 1e-9 &&
        b.max[2] >= 6.0 - 1e-9 &&
        b.max[0] > 1.0 &&
        b.min[0] < 1.8 &&
        b.max[1] > 3.6 &&
        b.min[1] < 4.6;
      expect(blocks, `${m.id} blocks the exit`).toBe(false);
    }
  });

  it("test_floor_with_hole_area", () => {
    expect(areaXZ(byId(g, "loft:floor"))).toBeCloseTo(26 - 0.9 * 4.246667, 4);
  });

  it("test_rail_uses_room_wall_thickness", () => {
    // hall gets a thicker wall and its right edge moves out to match (F1):
    // inner face sits at 2.07 - 0.2/2 = 1.97, clearance to the flight edge
    // at x=1.85 is 0.12 m — still no rail, but only once thickness is read
    // from `walls.thickness` instead of the nonexistent `thickness`.
    const scene = demo();
    const hall = scene.rooms.find((r: any) => r.id === "hall");
    hall.walls.thickness = 0.2;
    hall.shape[1] = [2.07, 4];
    hall.shape[2] = [2.07, 12];
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    expect(built.meshes.some((m) => m.id === "up:rail:right")).toBe(false);
  });

  it("test_rail_checks_clearance_past_sample_step", () => {
    // a 0.001 m sliver of hall's left wall pokes in to x=0.8 at z in
    // [7.001, 7.002] only — thinner than any fixed sampling step, but still
    // within 0.15 m of the flight's left edge at x=0.95 (F3)
    const scene = demo();
    const hall = scene.rooms.find((r: any) => r.id === "hall");
    hall.shape = [
      [-2, 4],
      [2, 4],
      [2, 12],
      [-2, 12],
      [-2, 7.002],
      [0.8, 7.002],
      [0.8, 7.001],
      [-2, 7.001],
    ];
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    expect(built.meshes.some((m) => m.id === "up:rail:left")).toBe(false);
  });

  it("test_slab_uses_footprint_overlap_not_centroid", () => {
    // hall and loft share an identical L-shaped footprint; the unweighted
    // vertex average of that outline can land in the notch that's cut out of
    // it, so a centroid-in-polygon check wrongly says "no room below" (F4)
    const scene = {
      version: 0,
      name: "slab-overlap",
      spawn: { room: "hall", at: [-1, 5], yaw: 180 },
      style: { ambient: 1.0, exterior: "#8a8a80" },
      materials: { parquet: { color: "#7a5230" }, white: { color: "#eeeae0" } },
      assets: {},
      levels: [
        { id: "L0", y: 0 },
        { id: "L1", y: 3.6 },
      ],
      rooms: [
        {
          id: "hall",
          level: "L0",
          height: 3.0,
          shape: [
            [-2, 4],
            [2, 4],
            [2, 12],
            [0.8, 12],
            [0.8, 7],
            [-2, 7],
          ],
          floor: "parquet",
          ceiling: "white",
          walls: { material: "white" },
        },
        {
          id: "loft",
          level: "L1",
          height: 2.8,
          shape: [
            [-2, 4],
            [2, 4],
            [2, 12],
            [0.8, 12],
            [0.8, 7],
            [-2, 7],
          ],
          floor: "parquet",
          ceiling: "white",
          walls: { material: "white" },
        },
      ],
    };
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    const slab = byId(built, "loft:slab");
    expect(slab.kind).toBe("slab");
    const sb = meshBBox(slab);
    expect(sb.min[1]).toBeCloseTo(3.0, 6);
    expect(sb.max[1]).toBeCloseTo(3.6, 6);
  });

  it("test_rail_checks_clearance_along_whole_flight", () => {
    // a notch in hall's left wall pokes in to x=0.8 only between z=7.0 and
    // z=7.5 — away from the three old sample points (z=11.6, 8.8, 6.0) and
    // clear of the spawn point at (-1, 10), but well within 0.15 m of the
    // flight's left edge at x=0.95 (F2)
    const scene = demo();
    const hall = scene.rooms.find((r: any) => r.id === "hall");
    hall.shape = [
      [-2, 4],
      [2, 4],
      [2, 12],
      [-2, 12],
      [-2, 7.5],
      [0.8, 7.5],
      [0.8, 7.0],
      [-2, 7.0],
    ];
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    expect(built.meshes.some((m) => m.id === "up:rail:left")).toBe(false);
  });

  it("test_rail_uses_shared_wall_thickness", () => {
    // hall shares the wall at x = -2 with a thicker-walled room, so that wall
    // is built 0.4 m thick and its inner face sits at x = -1.8; the flight's
    // left edge at x = -1.7 is only 0.10 m away, so no left rail (F5). Reading
    // thickness off hall alone (0.12) says 0.24 m and wrongly builds one.
    const scene = demo();
    scene.rooms.push({
      id: "west",
      level: "L0",
      height: 3.0,
      shape: [
        [-6, 4],
        [-2, 4],
        [-2, 12],
        [-6, 12],
      ],
      floor: "parquet",
      ceiling: "white",
      walls: { material: "white", thickness: 0.4 },
    });
    scene.openings.push({
      id: "west-door",
      kind: "door",
      at: [-2, 8],
      width: 0.9,
      height: 2.1,
      sill: 0,
    });
    scene.stairs[0].from.at = [-1.25, 11.6];
    // the flight now runs over the demo spawn point; move spawn clear of its
    // footprint so this stays a test of rail clearance, not of stair nav
    scene.spawn = { room: "hall", at: [1, 5], yaw: 180 };
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    expect(built.meshes.some((m) => m.id === "up:rail:left")).toBe(false);
  });

  it("test_slab_uses_positive_overlap_area", () => {
    // the upper room hangs off the side of the one below: their footprints
    // overlap over 3 m², but neither contains the other's corner and their
    // edges only touch at the corners, so a centroid-or-crossing test misses
    // the overlap and skips the slab (F6)
    const scene = {
      version: 0,
      name: "slab-partial",
      spawn: { room: "lower", at: [1.5, 1.5], yaw: 0 },
      style: { ambient: 1.0, exterior: "#8a8a80" },
      materials: { parquet: { color: "#7a5230" }, white: { color: "#eeeae0" } },
      assets: {},
      levels: [
        { id: "L0", y: 0 },
        { id: "L1", y: 3.6 },
      ],
      rooms: [
        {
          id: "lower",
          level: "L0",
          height: 3.0,
          shape: [
            [0, 0],
            [3, 0],
            [3, 3],
            [0, 3],
          ],
          floor: "parquet",
          ceiling: "white",
          walls: { material: "white" },
        },
        {
          id: "upper",
          level: "L1",
          height: 2.8,
          shape: [
            [4, 0],
            [4, 3],
            [2, 3],
            [2, 0],
          ],
          floor: "parquet",
          ceiling: "white",
          walls: { material: "white" },
        },
      ],
    };
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    const slab = byId(built, "upper:slab");
    expect(slab.kind).toBe("slab");
    const sb = meshBBox(slab);
    expect(sb.min[1]).toBeCloseTo(3.0, 6);
    expect(sb.max[1]).toBeCloseTo(3.6, 6);
  });

  it("test_rail_uses_thickness_of_its_own_wall_stretch", () => {
    // west is 0.4-walled but shares only z in [4, 5] of hall's x = -2 edge, so
    // that edge is split into a 0.4 interval (by z = 5) and a 0.12 one; the
    // flight runs along the thin stretch only, 0.24 m from its face, so the
    // left rail stays (F7). One max thickness per edge pushes the face in to
    // x = -1.8 along the whole edge and drops it.
    const scene = demo();
    scene.rooms.push({
      id: "west",
      level: "L0",
      height: 3.0,
      shape: [
        [-6, 4],
        [-2, 4],
        [-2, 5],
        [-6, 5],
      ],
      floor: "parquet",
      ceiling: "white",
      walls: { material: "white", thickness: 0.4 },
    });
    scene.openings.push({ id: "west-door", kind: "door", at: [-2, 4.5], width: 0.6, height: 2.1, sill: 0 });
    scene.stairs[0].from.at = [-1.25, 11.6];
    // the flight now runs over the demo spawn point; move spawn clear of its
    // footprint so this stays a test of rail clearance, not of stair nav
    scene.spawn = { room: "hall", at: [1, 5], yaw: 180 };
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    expect(built.meshes.some((m) => m.id === "up:rail:left")).toBe(true);
  });

  it("test_rail_keeps_clear_of_free_wall", () => {
    // a free wall stands in hall 0.10 m off the flight's left face (axis at
    // x = 0.79, face at 0.85, flight edge at 0.95): no left rail, though the
    // room's own walls are far away. Inner faces re-derived from the room
    // outline never see it; the built wall faces do.
    const scene = demo();
    scene.walls = [{ level: "L0", from: [0.79, 9.0], to: [0.79, 10.0], thickness: 0.12, material: "white", h: 1.0 }];
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    expect(built.meshes.some((m) => m.id.startsWith("walls#0"))).toBe(true);
    expect(built.meshes.some((m) => m.id === "up:rail:left")).toBe(false);
  });

  it("test_slab_counts_sub_millimetre_overlap", () => {
    // the upper room overlaps the lower one by a strip 0.0004 m wide; rounding
    // both outlines to millimetres closes the strip and loses the slab (F8)
    const scene = {
      version: 0,
      name: "slab-sliver",
      spawn: { room: "lower", at: [0.5, 0.5], yaw: 0 },
      style: { ambient: 1.0, exterior: "#8a8a80" },
      materials: { parquet: { color: "#7a5230" }, white: { color: "#eeeae0" } },
      assets: {},
      levels: [
        { id: "L0", y: 0 },
        { id: "L1", y: 3.6 },
      ],
      rooms: [
        {
          id: "lower",
          level: "L0",
          height: 3.0,
          shape: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          floor: "parquet",
          ceiling: "white",
          walls: { material: "white" },
        },
        {
          id: "upper",
          level: "L1",
          height: 2.8,
          shape: [
            [0.9996, 0],
            [2, 0],
            [2, 1],
            [0.9996, 1],
          ],
          floor: "parquet",
          ceiling: "white",
          walls: { material: "white" },
        },
      ],
    };
    const { report, ctx } = runCheck(scene);
    expect(report.errors).toEqual([]);
    const built = buildGeometry(ctx);
    const sb = meshBBox(byId(built, "upper:slab"));
    expect(sb.min[1]).toBeCloseTo(3.0, 6);
    expect(sb.max[1]).toBeCloseTo(3.6, 6);
  });

  it("test_footprints_overlap_is_exact", () => {
    const sq = (x0: number, z0: number, x1: number, z1: number): P2[] => [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ];
    const unit = sq(0, 0, 1, 1);
    // positive area however thin, either orientation, containment, identity
    expect(footprintsOverlap(unit, sq(0.9996, 0, 2, 1))).toBe(true);
    expect(footprintsOverlap(unit, sq(1 - 1e-9, 0, 2, 1))).toBe(true);
    expect(footprintsOverlap(unit, [...sq(0.5, 0.5, 3, 3)].reverse())).toBe(true);
    expect(footprintsOverlap(unit, sq(0.25, 0.25, 0.75, 0.75))).toBe(true);
    expect(footprintsOverlap(sq(0.25, 0.25, 0.75, 0.75), unit)).toBe(true);
    expect(footprintsOverlap(unit, unit)).toBe(true);
    // a cross: no vertex of either inside the other, edges cross properly
    expect(footprintsOverlap(sq(-1, 0.4, 2, 0.6), sq(0.4, -1, 0.6, 2))).toBe(true);
    // touching along an edge, at a corner, or apart: zero area
    expect(footprintsOverlap(unit, sq(1, 0, 2, 1))).toBe(false);
    expect(footprintsOverlap(unit, sq(1, 0.3, 2, 0.6))).toBe(false);
    expect(footprintsOverlap(unit, sq(1, 1, 2, 2))).toBe(false);
    expect(footprintsOverlap(unit, sq(1 + 1e-9, 0, 2, 1))).toBe(false);
    // an L whose notch holds the other square: touches on two sides only
    const l: P2[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ];
    expect(footprintsOverlap(l, sq(1, 1, 2, 2))).toBe(false);
    expect(footprintsOverlap(l, sq(0.999, 1, 2, 2))).toBe(true);
  });
});
