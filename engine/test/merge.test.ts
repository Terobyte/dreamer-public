import { describe, expect, it } from "vitest";
import { Clipper, PointInPolygonResult } from "clipper2-ts";
import { runCheck } from "../src/check.js";
import { demoFlat, patched } from "./helpers/scene.js";
import { wallBody } from "../src/plan/body.js";
import { readFileSync } from "node:fs";

function sceneWith(rooms: any[]): any {
  return {
    version: 0,
    name: "t",
    spawn: { room: rooms[0].id, at: [1, 1], yaw: 0 },
    materials: { m: { color: "#ffffff" } },
    assets: {},
    levels: [{ id: "L0", y: 0 }],
    rooms: rooms.map((r) => ({
      level: "L0",
      height: 3,
      floor: "m",
      ceiling: "m",
      walls: { material: "m" },
      ...r,
    })),
  };
}

function rect(id: string, x0: number, z0: number, x1: number, z1: number): any {
  return { id, shape: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] };
}

function hz(intervals: any[], z: number): any[] {
  return intervals.filter((iv: any) => Math.abs(iv.from[1] - z) < 1e-9 && Math.abs(iv.to[1] - z) < 1e-9);
}

function xRange(iv: any): [number, number] {
  return [Math.min(iv.from[0], iv.to[0]), Math.max(iv.from[0], iv.to[0])];
}

function roomsOf(iv: any): string[] {
  const rooms: string[] = iv.sides.map((s: any) => String(s.room));
  return [...new Set(rooms)].sort();
}

describe("plan merge", () => {
  it("demo_flat_sides", () => {
    const { report, ctx } = runCheck(demoFlat(), { until: "plan" });
    const edges = report.passport.edges as any[];
    const l3 = edges.find((e) => e.id === "living#3");
    const h0 = edges.find((e) => e.id === "hall#0");
    expect(l3.sides).toEqual([{ room: "hall", m: [2, 6] }]);
    expect(h0.sides).toEqual([{ room: "living", m: [0, 4] }]);
    const ivs = hz((ctx.levels as any).get("L0").intervals, 4);
    expect(ivs.map(xRange).sort((a, b) => a[0] - b[0])).toEqual([[ -4, -2 ], [ -2, 2 ], [2, 4]]);
    expect(ivs.map(roomsOf).sort()).toEqual([["hall", "living"], ["living"], ["living"]].sort());
  });

  it("t_junction", () => {
    const { ctx } = runCheck(
      sceneWith([rect("A", 0, 0, 6, 4), rect("B", 0, 4, 3, 8), rect("C", 3, 4, 6, 8)]),
      { until: "plan" },
    );
    const ivs = hz((ctx.levels as any).get("L0").intervals, 4).sort((a: any, b: any) => xRange(a)[0] - xRange(b)[0]);
    expect(ivs.map(xRange)).toEqual([[0, 3], [3, 6]]);
    expect(ivs.map(roomsOf)).toEqual([["A", "B"], ["A", "C"]]);
    const vert = (ctx.levels as any)
      .get("L0")
      .intervals.filter((iv: any) => Math.abs(iv.from[0] - 3) < 1e-9 && Math.abs(iv.to[0] - 3) < 1e-9)
      .filter((iv: any) => Math.min(iv.from[1], iv.to[1]) >= 4 - 1e-9);
    expect(vert.length).toBe(1);
    expect(roomsOf(vert[0])).toEqual(["B", "C"]);
  });

  it("partial_overlap", () => {
    const { ctx } = runCheck(sceneWith([rect("A", 0, 0, 6, 4), rect("B", 2, 4, 4, 8)]), { until: "plan" });
    const ivs = hz((ctx.levels as any).get("L0").intervals, 4).sort((a: any, b: any) => xRange(a)[0] - xRange(b)[0]);
    expect(ivs.map(xRange)).toEqual([[0, 2], [2, 4], [4, 6]]);
    expect(ivs.map(roomsOf)).toEqual([["A"], ["A", "B"], ["A"]]);
  });

  it("two_arcs_shared", () => {
    const A = { id: "A", shape: [[3, 0, { bulge: 1 }], [-3, 0], [-3, -4], [3, -4]] };
    const B = { id: "B", shape: [[-3, 0, { bulge: -1 }], [3, 0], [3, 6], [-3, 6]] };
    const { ctx } = runCheck(sceneWith([A, B]), { until: "plan" });
    const arcs = (ctx.levels as any).get("L0").intervals.filter((iv: any) => iv.arc);
    expect(arcs.length).toBe(1);
    expect(arcs[0].arc.c[0]).toBeCloseTo(0, 6);
    expect(arcs[0].arc.c[1]).toBeCloseTo(0, 6);
    expect(arcs[0].arc.r).toBeCloseTo(3, 6);
    expect(roomsOf(arcs[0])).toEqual(["A", "B"]);
  });

  it("arc interval keeps the authored sweep side", () => {
    const A = { id: "A", shape: [[3, 0, { bulge: -1 }], [-3, 0], [-3, -4], [3, -4]] };
    const { ctx } = runCheck(sceneWith([A]), { until: "plan" });
    const plan = (ctx.levels as any).get("L0");
    const arcs = plan.intervals.filter((iv: any) => iv.arc);
    expect(arcs.length).toBe(1);
    // bulge < 0 bows the wall away from the room interior, i.e. onto -Z here
    expect(arcs[0].arc.sweep).toBeCloseTo(Math.PI, 6);
    const pointInPoly = (poly: any, x: number, z: number) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x / 1000;
        const zi = poly[i].y / 1000;
        const xj = poly[j].x / 1000;
        const zj = poly[j].y / 1000;
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    const insideBody = (x: number, z: number) => plan.body.filter((p: any) => pointInPoly(p, x, z)).length % 2 === 1;
    expect(insideBody(0, -2.95)).toBe(true);
    expect(insideBody(0, 2.95)).toBe(false);
  });

  it("snap merges close vertices", () => {
    const mk = (d: number) => sceneWith([rect("A", 0, 0, 4, 4), rect("B", 4 + d, 0, 8, 4)]);
    const c1 = runCheck(mk(0.06), { until: "plan" });
    expect((c1.ctx.levels as any).get("L0").snaps.length).toBe(2);
    const shared = (c1.ctx.levels as any).get("L0").intervals.filter((iv: any) => roomsOf(iv).join() === "A,B");
    expect(shared.length).toBeGreaterThan(0);
    const c2 = runCheck(mk(0.3), { until: "plan" });
    expect(c2.report.errors.length).toBe(0);
    expect(c2.report.warnings.filter((w) => w.code === "EDGES_DRIFT").length).toBe(1);
    const w = c2.report.warnings.find((x) => x.code === "EDGES_DRIFT")!;
    expect(w.path).toBe("/rooms/1/shape");
    expect(w.fix).toEqual({ "3": [4, 4], "0": [4, 0] });
  });

  it("drift_warn_file", () => {
    const ops = JSON.parse(readFileSync(new URL("./scenes/warn/EDGES_DRIFT.patch.json", import.meta.url), "utf-8"));
    expect(ops).toEqual([
      { op: "replace", path: "/rooms/1/shape", value: [[-2, 4], [0.6, 4], [1, 4.3], [2, 4.3], [2, 12], [-2, 12]] },
    ]);
    const { report } = runCheck(patched(ops), { until: "plan" });
    expect(report.errors.length).toBe(0);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0].code).toBe("EDGES_DRIFT");
    expect(report.warnings[0].fix).toEqual({ "2": [1, 4], "3": [2, 4] });
    const fixed = patched([
      ...ops,
      { op: "replace", path: "/rooms/1/shape/2", value: [1, 4] },
      { op: "replace", path: "/rooms/1/shape/3", value: [2, 4] },
    ]);
    const r2 = runCheck(fixed, { until: "plan" });
    expect(r2.report.errors.length).toBe(0);
    expect(r2.report.warnings.length).toBe(0);
  });

  it("wall_body_mitre", () => {
    const { ctx } = runCheck(sceneWith([rect("A", -2, -2, 2, 2)]), { until: "plan" });
    const plan = (ctx.levels as any).get("L0");
    const body = wallBody(plan.intervals);
    expect(body.length).toBe(2);
    const areas = body.map((p: any) => Math.abs(Clipper.area(p)) / 1e6).sort((a: number, b: number) => b - a);
    expect(areas[0]).toBeCloseTo(16.9744, 3);
    expect(areas[1]).toBeCloseTo(15.0544, 3);
  });

  it("wall_body_open_t", () => {
    const { ctx } = runCheck(
      sceneWith([rect("A", 0, 0, 6, 4), rect("B", 0, 4, 3, 8), rect("C", 3, 4, 6, 8)]),
      { until: "plan" },
    );
    const plan = (ctx.levels as any).get("L0");
    const body = wallBody(plan.intervals);
    const pointInPoly = (poly: any, x: number, z: number) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x / 1000;
        const zi = poly[i].y / 1000;
        const xj = poly[j].x / 1000;
        const zj = poly[j].y / 1000;
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    // nesting depth of each path: a path with an even number of containing paths is a top-level outer boundary
    const containCount = (idx: number) =>
      body.filter((q: any, j: number) => j !== idx && pointInPoly(q, body[idx][0].x / 1000, body[idx][0].y / 1000)).length;
    const outerCount = body.filter((_: any, idx: number) => containCount(idx) % 2 === 0).length;
    const insideBody = (x: number, z: number) => body.filter((p: any) => pointInPoly(p, x, z)).length % 2 === 1;
    expect(body.length).toBeGreaterThan(0);
    expect(outerCount).toBe(1);
    expect(insideBody(3, 4)).toBe(true);
    expect(insideBody(3, 6)).toBe(true);
    expect(insideBody(0, 4)).toBe(true);
    expect(insideBody(3.1, 4.1)).toBe(false);
  });

  it("wall thickness from walls.thickness propagates to intervals", () => {
    const room = { ...rect("A", 0, 0, 4, 4), walls: { material: "m", thickness: 0.5 } };
    const { ctx } = runCheck(sceneWith([room]), { until: "plan" });
    const plan = (ctx.levels as any).get("L0");
    expect(plan.intervals.length).toBeGreaterThan(0);
    for (const iv of plan.intervals) expect(iv.thickness).toBeCloseTo(0.5, 6);
  });

  it("wall_body offsets each interval by its own thickness", () => {
    const mk = (from: any, to: any, thickness: number, edge: number): any => ({
      from,
      to,
      arc: null,
      sides: [{ room: "A", edge, m: [0, 4] }],
      thickness,
    });
    const body = wallBody([
      mk([0, 0], [4, 0], 0.12, 0),
      mk([4, 0], [4, 4], 0.12, 1),
      mk([4, 4], [0, 4], 0.5, 2),
      mk([0, 4], [0, 0], 0.12, 3),
    ]);
    const pointInPoly = (poly: any, x: number, z: number) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x / 1000;
        const zi = poly[i].y / 1000;
        const xj = poly[j].x / 1000;
        const zj = poly[j].y / 1000;
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    const insideBody = (x: number, z: number) => body.filter((p: any) => pointInPoly(p, x, z)).length % 2 === 1;
    // the 0.12 m wall on x=0 only extends 0.06 m, not the 0.5 m wall's 0.25 m
    expect(insideBody(-0.1, 2)).toBe(false);
    expect(insideBody(-0.05, 2)).toBe(true);
  });

  it("wall_body preserves the authored sweep for a half-turn arc", () => {
    const body = wallBody([
      {
        from: [3, 0],
        to: [-3, 0],
        arc: { c: [0, 0], r: 3 },
        sides: [
          { room: "A", edge: 0, m: [0, 3 * Math.PI] },
          { room: "B", edge: 0, m: [0, 3 * Math.PI] },
        ],
        thickness: 0.12,
      },
    ]);
    const pointInPoly = (poly: any, x: number, z: number) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x / 1000;
        const zi = poly[i].y / 1000;
        const xj = poly[j].x / 1000;
        const zj = poly[j].y / 1000;
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    const insideBody = (x: number, z: number) => body.filter((p: any) => pointInPoly(p, x, z)).length % 2 === 1;
    expect(insideBody(0, 2.95)).toBe(true);
    expect(insideBody(0, -2.95)).toBe(false);
  });

  it("level plan body is populated from its intervals", () => {
    const { ctx } = runCheck(demoFlat(), { until: "plan" });
    const plan = (ctx.levels as any).get("L0");
    expect(plan.body.length).toBeGreaterThan(0);
    expect(plan.body).toEqual(wallBody(plan.intervals));
  });
});

describe("terra re-review", () => {
  it("circle_and_arc_share_a_quarter", () => {
    const A = { id: "A", circle: { c: [0, 0], r: 3 } };
    const B = { id: "B", shape: [[0, 3, { bulge: -(Math.SQRT2 - 1) }], [3, 0], [5, 0], [5, 5], [0, 5]] };
    const scene = sceneWith([A, B]);
    const { ctx } = runCheck(scene, { until: "plan" });
    const arcs = (ctx.levels as any).get("L0").intervals.filter((iv: any) => iv.arc);
    expect(arcs.map(roomsOf).sort()).toEqual([["A"], ["A", "B"]]);
    const shared = arcs.find((iv: any) => iv.sides.length === 2);
    const a = shared.sides.find((x: any) => x.room === "A");
    expect(a.m[0]).toBeCloseTo(0, 6);
    expect(a.m[1]).toBeCloseTo((Math.PI / 2) * 3, 6);
    const rest = arcs.find((iv: any) => iv.sides.length === 1).sides[0];
    expect(rest.m[0]).toBeCloseTo((Math.PI / 2) * 3, 6);
    expect(rest.m[1]).toBeCloseTo(2 * Math.PI * 3, 6);
    // a door on the shared quarter joins both rooms
    scene.assets = { x: { kind: "decal", prompt: "x" } };
    scene.openings = [{ id: "d", kind: "arch", at: [3 * Math.SQRT1_2, 3 * Math.SQRT1_2], width: 0.9 }];
    const out = runCheck(scene, { until: "openings" });
    expect(out.report.errors).toEqual([]);
    expect((out.report.passport.openings as any[])[0].rooms).toEqual(["A", "B"]);
    // `on` the circle picks the interval under the opening, on either part
    for (const [az, rooms] of [[45, ["A", "B"]], [200, ["A"]]] as const) {
      scene.openings = [{ id: "d", kind: "window", on: { room: "A", edge: 0, az }, width: 0.9, height: 1, sill: 1, outside: { backdrop: "x" } }];
      const o = runCheck(scene, { until: "openings" });
      expect(o.report.errors.filter((e) => e.path.startsWith("/openings"))).toEqual([]);
      expect((o.report.passport.openings as any[])[0].rooms).toEqual(rooms);
    }
  });

  it("wall_body_independent_of_interval_order", () => {
    const A = { id: "A", shape: [[0, 0], [4, 0], [1, 1]], walls: { material: "m", thickness: 0.4 } };
    const B = { id: "B", shape: [[0, 0], [4, -3], [4, 0]], walls: { material: "m", thickness: 0.4 } };
    const { ctx } = runCheck(sceneWith([A, B]), { until: "plan" });
    const ivs = (ctx.levels as any).get("L0").intervals as any[];
    const area = (list: any[]): number => Clipper.areaPaths(wallBody(list));
    const base = area(ivs);
    for (let k = 1; k < ivs.length; k++) {
      expect(area([...ivs.slice(k), ...ivs.slice(0, k)])).toBeCloseTo(base, 6);
      expect(area([...ivs].reverse())).toBeCloseTo(base, 6);
    }
  });

  it("side_m_from_authored_vertex", () => {
    // B's [0.06, 4] snaps to [0, 4]: the shared interval x in [0.06.., 2] is m [0, 1.94] on B#0
    const A = rect("A", 0, 0, 2, 4);
    const B = { id: "B", shape: [[0.06, 4], [0.06, 8], [4, 8], [4, 4]] };
    const { ctx } = runCheck(sceneWith([A, B]), { until: "plan" });
    const ivs = hz((ctx.levels as any).get("L0").intervals, 4);
    const shared = ivs.find((iv: any) => iv.sides.length === 2);
    const b = shared.sides.find((x: any) => x.room === "B");
    expect(b.m[0]).toBeCloseTo(4 - 2 - 0.06 + 0.06, 6);
    expect(b.m[1]).toBeCloseTo(4 - 0.06, 6);
  });

  it("same_ends_opposite_halves_stay_apart", () => {
    // both semicircles run [3,0] <-> [-3,0] on one circle, but over opposite halves
    const A = { id: "A", shape: [[3, 0, { bulge: -1 }], [-3, 0], [-3, -4], [3, -4]] };
    const B = { id: "B", shape: [[-3, 0, { bulge: -1 }], [3, 0], [3, 4], [-3, 4]] };
    const { ctx } = runCheck(sceneWith([A, B]), { until: "plan" });
    const arcs = (ctx.levels as any).get("L0").intervals.filter((iv: any) => iv.arc);
    expect(arcs.map(roomsOf).sort()).toEqual([["A"], ["B"]]);
  });

  it("passport_arc_sides_use_interval_m", () => {
    const A = { id: "A", circle: { c: [0, 0], r: 3 } };
    const B = { id: "B", shape: [[0, 3, { bulge: -(Math.SQRT2 - 1) }], [3, 0], [5, 0], [5, 5], [0, 5]] };
    const { report } = runCheck(sceneWith([A, B]), { until: "plan" });
    const a0 = (report.passport.edges as any[]).find((e) => e.id === "A#0");
    expect(a0.sides).toEqual([{ room: "B", m: [0, 4.712] }]);
    expect(Object.keys(a0.arc).sort()).toEqual(["c", "r"]);
  });

  it("near_parallel_edges_share_over_their_overlap", () => {
    // B's edge drifts 0.02..0.18 m from A's line, but only 0.02..0.06 m over the shared part
    const A = { id: "A", shape: [[0, 0], [10, 0], [10, -4], [0, -4]] };
    const B = { id: "B", shape: [[5, 0.02], [5, 4], [25, 4], [25, 0.18]] };
    const { ctx } = runCheck(sceneWith([A, B]), { until: "plan" });
    const ivs = (ctx.levels as any).get("L0").intervals as any[];
    expect(ivs.some((iv) => iv.sides.length === 2)).toBe(true);
  });

  it("arc_side_m_uses_own_radius", () => {
    const A = { id: "A", circle: { c: [0, 0], r: 3 } };
    const k = Math.SQRT2 - 1;
    const B = { id: "B", shape: [[0, 3.05, { bulge: -k }], [3.05, 0], [5, 0], [5, 5], [0, 5]] };
    const { ctx } = runCheck(sceneWith([A, B]), { until: "plan" });
    const shared = (ctx.levels as any).get("L0").intervals.find((iv: any) => iv.arc && iv.sides.length === 2);
    const b = shared.sides.find((x: any) => x.room === "B");
    expect(b.m[0]).toBeCloseTo(0, 3);
    expect(b.m[1]).toBeCloseTo((Math.PI / 2) * 3.05, 3);
  });

  it("vertices_exactly_snap_eps_apart_do_not_merge", () => {
    const { report, ctx } = runCheck(sceneWith([rect("A", 0, 0, 4, 4), rect("B", 4.1, 0, 8, 4)]), { until: "plan" });
    expect((ctx.levels as any).get("L0").snaps).toEqual([]);
    expect(report.warnings.map((w) => w.code)).toContain("EDGES_DRIFT");
  });

  it("t_junction_adjoining_walls_follow_projection", () => {
    // B's bottom joins A's top wall at z = 0; its side walls must end there too
    const A = { id: "A", shape: [[0, 0], [6, 0], [6, -4], [0, -4]], walls: { material: "m", thickness: 0.02 } };
    const B = { id: "B", shape: [[2, 0.05], [2, 4], [4, 4], [4, 0.05]], walls: { material: "m", thickness: 0.02 } };
    const { ctx } = runCheck(sceneWith([A, B]), { until: "plan" });
    const plan = (ctx.levels as any).get("L0");
    const side = plan.intervals.find((iv: any) => iv.sides.some((s: any) => s.room === "B" && s.edge === 0));
    expect(Math.min(side.from[1], side.to[1])).toBeCloseTo(0, 6);
    // and the body is closed at the junction
    const inside = (plan.body as any[]).some((path) => Clipper.pointInPolygon({ x: 2000, y: 25 }, path) !== PointInPolygonResult.IsOutside);
    expect(inside).toBe(true);
  });
});

