import { describe, expect, beforeAll, test } from "vitest";
import { readFileSync } from "node:fs";
import { Clipper } from "clipper2-ts";
import { runCheck } from "../src/check.js";
import { roomGraph } from "../src/openings/graph.js";
import { cutPath } from "../src/openings/stage.js";
import { round3 } from "../src/report/report.js";
import { demoFlat, patched } from "./helpers/scene.js";
import type { Report } from "../src/types.js";

let flatReport: Report;
let flatCtx: any;

beforeAll(() => {
  const out = runCheck(demoFlat());
  flatReport = out.report;
  flatCtx = out.ctx;
});

function passOf(r: Report, id: string): any {
  return (r.passport.openings as any[]).find((o) => o.id === id);
}

describe("openings", () => {
  test("test_demo_flat_front", () => {
    expect(flatReport.errors).toEqual([]);
    const f = passOf(flatReport, "front");
    expect(f.edge).toBe("living#3");
    expect(f.m).toBe(4.0);
    expect(f.rooms).toEqual(["living", "hall"]);
    expect(f.swing).toBe("living");
    expect(f.hinge).toBe("left");
    expect(round3(f.hinge_at[0])).toBe(0.45);
    expect(round3(f.hinge_at[1])).toBe(3.94);
  });

  test("test_hinge_not_tie", () => {
    const { report } = runCheck(patched([{ op: "replace", path: "/openings/0/at", value: [1.5, 4] }]));
    expect(report.errors).toEqual([]);
    const f = passOf(report, "front");
    expect(f.hinge).toBe("left");
    expect(round3(f.hinge_at[0])).toBe(1.95);
    expect(round3(f.hinge_at[1])).toBe(3.94);
  });

  test("test_demo_flat_window_arc", () => {
    expect(flatReport.errors).toEqual([]);
    const s = passOf(flatReport, "sea");
    expect(s.edge).toBe("living#1");
    expect(round3(s.center[0]) + 0).toBe(0);
    expect(round3(s.center[1])).toBe(-5.6);
    expect(s.rooms).toEqual(["living"]);
    expect(s.swing).toBeNull();
    expect(s.hinge).toBeNull();
  });

  test("test_corridor_height", () => {
    const s = passOf(flatReport, "sea");
    expect(s.sill).toBe(1.0);
    expect(s.height).toBe(1.0);
    expect(s.corridor).toHaveLength(4);
  });

  test("test_body_after_cut", () => {
    const area = (paths: Array<{ x: number; y: number }[]>): number => {
      let a = 0;
      for (const p of paths) a += Clipper.area(p);
      return a / 1e6;
    };
    const full = area(flatCtx.levels.get("L0").body);
    expect(full).toBeGreaterThan(0);
    // body with only front removed, sea window kept: delta isolates front cut
    const noFront = runCheck(patched([{ op: "remove", path: "/openings/0" }]));
    const noFrontArea = area((noFront.ctx as any).levels.get("L0").body);
    expect(noFrontArea - full).toBeCloseTo(0.108, 3);
    expect(full).toBeLessThan(noFrontArea);
  });

  test("test_circle_window_seam", () => {
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "w", kind: "window", on: { room: "r", edge: 0, t: 0 }, width: 1.0, outside: { backdrop: "x" } }],
    };
    const { report } = runCheck(raw);
    expect(report.errors).toEqual([]);
    const w = passOf(report, "w");
    expect(round3(w.center[0]) + 0).toBe(0);
    expect(round3(w.center[1])).toBe(3);
  });

  test("test_arc_cut_along_chord", () => {
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "w", kind: "window", on: { room: "r", edge: 0, t: 0 }, width: 1.0, outside: { backdrop: "x" } }],
    };
    const { ctx } = runCheck(raw, { until: "openings" });
    const g = (ctx as any).openings[0];
    // the cut is a chord rectangle: 4 corners, chord ends unchanged; across the
    // wall it spans thickness/2 below the chord and thickness/2 past the axis
    // midpoint (the sagitta), so no arc segment survives between the jambs
    const path = cutPath(g);
    expect(path.length).toBe(4);
    const zc = (g.ends[0][1] + g.ends[1][1]) / 2;
    const sag = g.center[1] - zc;
    const xs = path.map((q: any) => Math.abs(q.x) / 1000).sort((a: number, b: number) => a - b);
    for (const x of xs) expect(x).toBeCloseTo(0.5, 3);
    const zs = path.map((q: any) => q.y / 1000 - zc);
    expect(Math.min(...zs)).toBeCloseTo(-g.thickness / 2, 3);
    expect(Math.max(...zs)).toBeCloseTo(sag + g.thickness / 2, 3);
  });

  test("test_arc_body_flat_jambs", () => {
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "w", kind: "window", on: { room: "r", edge: 0, t: 0 }, width: 1.0, outside: { backdrop: "x" } }],
    };
    const { ctx } = runCheck(raw, { until: "openings" });
    const g = (ctx as any).openings[0];
    const body = (ctx as any).levels.get("L0").body;
    const inBody = (x: number, z: number): boolean => {
      const pt = { x: Math.round(x * 1000), y: Math.round(z * 1000) };
      let n = 0;
      for (const p of body) if (Clipper.pointInPolygon(pt, p) === 1) n++;
      return n % 2 === 1;
    };
    const t = g.thickness;
    const rr = 3 + 0.4 * t;
    // between the jambs nothing is left, also outside the chord band (outer arc face)
    expect(inBody(0, rr)).toBe(false);
    expect(inBody(0.45, Math.sqrt(rr * rr - 0.45 ** 2))).toBe(false);
    // just past the flat jamb x = 0.5, still inside the old radial end cap: wall stays
    const x = 0.5 * (1 + (0.2 * t) / 3);
    expect(inBody(x, Math.sqrt(rr * rr - x * x))).toBe(true);
    expect(inBody(-x, Math.sqrt(rr * rr - x * x))).toBe(true);
    // far from the opening the wall is intact
    expect(inBody(0, -3)).toBe(true);
  });

  test("test_door_at_corner", () => {
    const ops = JSON.parse(readFileSync(new URL("./scenes/broken/OPENING_OFF_EDGE.patch.json", import.meta.url), "utf-8"));
    const { report } = runCheck(patched(ops));
    expect(report.errors.map((e) => e.code)).toEqual(["OPENING_OFF_EDGE"]);
  });

  test("test_broken_opening_codes", () => {
    for (const code of ["OPENING_NO_WALL", "OPENING_OFF_EDGE", "OPENING_OVERLAP", "OPENING_TOO_HIGH", "OPENING_NO_OUTSIDE", "ROOM_UNREACHABLE"]) {
      const ops = JSON.parse(readFileSync(new URL(`./scenes/broken/${code}.patch.json`, import.meta.url), "utf-8"));
      const { report } = runCheck(patched(ops));
      expect(report.errors.map((e) => e.code)).toEqual([code]);
      if (code === "OPENING_NO_WALL") {
        expect(report.errors[0].fix).toEqual({ at: [4, 0] });
      }
      expect(report.warnings).toEqual([]);
    }
  });

  test("test_demo_flat_no_warnings", () => {
    expect(flatReport.errors).toEqual([]);
    expect(flatReport.warnings).toEqual([]);
  });

  test("test_circle_two_windows_no_overlap", () => {
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [
        { id: "w1", kind: "window", on: { room: "r", edge: 0, t: 0 }, width: 1.0, outside: { backdrop: "x" } },
        { id: "w2", kind: "window", on: { room: "r", edge: 0, t: 0.5 }, width: 1.0, outside: { backdrop: "x" } },
      ],
    };
    const { report } = runCheck(raw);
    expect(report.errors).toEqual([]);
  });

  test("test_at_snap_boundary", () => {
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "r", at: [4, 4], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, shape: [[0, 0], [8, 0], [8, 8], [0, 8]], floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "w", kind: "window", at: [2, 0.1], width: 0.9, outside: { backdrop: "x" } }],
    };
    const { report } = runCheck(raw, { until: "openings" });
    expect(report.errors.map((e) => e.code)).toEqual(["OPENING_NO_WALL"]);
  });

  test("test_closed_door_in_graph", () => {
    const { report } = runCheck(patched([{ op: "replace", path: "/openings/0/leaf/open", value: false }]), { until: "openings" });
    expect(report.errors.filter((e) => e.code === "ROOM_UNREACHABLE")).toEqual([]);
  });

  test("test_circle_door_hinge_inside", () => {
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "d", kind: "door", on: { room: "r", edge: 0, t: 0 }, width: 1.0, outside: { backdrop: "x" }, leaf: { decal: "x" } }],
    };
    const { report } = runCheck(raw);
    expect(report.errors).toEqual([]);
    const d = passOf(report, "d");
    expect(Math.hypot(d.hinge_at[0], d.hinge_at[1])).toBeLessThan(3);
  });

  test("test_room_graph_from_ctx", () => {
    const g = roomGraph(flatCtx);
    expect(g.get("living")).toContain("hall");
    expect(g.get("hall")).toContain("living");
  });

  test("test_canon_center_follows_canonical_edge", () => {
    const raw: any = {
      version: 0, name: "d",
      spawn: { room: "A", at: [1, 1] },
      materials: { m: { color: "#ffffff" } },
      assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [
        { id: "A", level: "L0", height: 3, shape: [[0, 0], [4, 0], [4, 4], [0, 4]], floor: "m", ceiling: "m", walls: { material: "m" } },
        { id: "B", level: "L0", height: 3, shape: [[4.05, 0], [8, 0], [8, 4], [4.05, 4]], floor: "m", ceiling: "m", walls: { material: "m" } },
      ],
      openings: [{ id: "w", kind: "door", on: { room: "B", edge: 3, t: 0.25 }, width: 1, leaf: { decal: "x", open: false } }],
    };
    const { report } = runCheck(raw, { until: "openings" });
    expect(report.errors).toEqual([]);
    const w = passOf(report, "w");
    expect(round3(w.center[0])).toBe(4);
    expect(round3(w.center[1])).toBe(3);
    expect(round3(w.hinge_at[0])).toBe(4.06);
  });

  test("test_arc_width_exceeds_diameter", () => {
    const raw: any = {
      version: 0, name: "w",
      spawn: { room: "r", at: [0, 0] },
      materials: { m: { color: "#ffffff" } },
      assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "w", kind: "window", on: { room: "r", edge: 0, t: 0 }, width: 7, outside: { backdrop: "x" } }],
    };
    const { report } = runCheck(raw, { until: "openings" });
    expect(report.errors.map((e) => e.code)).toEqual(["OPENING_OFF_EDGE"]);
  });

  test("test_arc_width_just_over_diameter", () => {
    const raw: any = {
      version: 0, name: "w",
      spawn: { room: "r", at: [0, 0] },
      materials: { m: { color: "#ffffff" } },
      assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "w", kind: "window", on: { room: "r", edge: 0, t: 0 }, width: 6.000001, outside: { backdrop: "x" } }],
    };
    const { report } = runCheck(raw, { until: "openings" });
    expect(report.errors.map((e) => e.code)).toEqual(["OPENING_OFF_EDGE"]);
  });

  test("test_at_on_circle_is_exact", () => {
    const raw: any = {
      version: 0, name: "a",
      spawn: { room: "r", at: [0, 0] },
      materials: { m: { color: "#ffffff" } },
      assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "w", kind: "window", at: [1.5, 2.598076211], width: 0.6, outside: { backdrop: "x" } }],
    };
    const { ctx } = runCheck(raw, { until: "openings" });
    const o = (ctx.openings as any[])[0];
    expect(o.center[0]).toBeCloseTo(1.5, 6);
    expect(o.center[1]).toBeCloseTo(2.598076211, 6);
    expect(o.m).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("terra re-review", () => {
  test("test_arc_opening_at_edge_start_no_overlap", () => {
    // living#1 has a negative sweep; a window whose range starts exactly at the
    // edge start must map to s = 0, not to the far end of the interval
    const { report } = runCheck(patched([
      { op: "replace", path: "/openings/1/on", value: { room: "living", edge: 1, m: 0.5006213827176226 } },
      { op: "replace", path: "/openings/1/width", value: 1 },
      { op: "add", path: "/openings/-", value: { id: "w2", kind: "window", on: { room: "living", edge: 1, t: 0.8 }, width: 1, height: 1, sill: 1, outside: { backdrop: "d_sea" } } },
    ]), { until: "openings" });
    expect(report.errors.filter((e) => e.stage === "openings")).toEqual([]);
  });

  test("test_circle_door_hinge_on_chord_face", () => {
    // jambs are the chord ends, the hinge sits on the swing-side face of the chord
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      openings: [{ id: "d", kind: "door", on: { room: "r", edge: 0, t: 0 }, width: 2, outside: { backdrop: "x" }, leaf: { decal: "x" } }],
    };
    const { report } = runCheck(raw, { until: "openings" });
    expect(report.errors).toEqual([]);
    const d = passOf(report, "d");
    expect(Math.abs(d.hinge_at[0])).toBeCloseTo(1, 3);
    expect(d.hinge_at[1]).toBeCloseTo(Math.sqrt(8) - 0.06, 3);
  });

  test("test_gap_height_from_resolved_level", () => {
    // the `at` point is 0.08 m from the L0 wall and on the L1 wall: resolution
    // takes L1, so the default height is the L1 ceiling
    const room = (id: string, level: string, h: number, z: number): any => ({
      id, level, height: h, shape: [[0, -4], [4, -4], [4, z], [0, z]],
      floor: "m", ceiling: "m", walls: { material: "m" },
    });
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "a", at: [2, -2], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }, { id: "L1", y: 3 }],
      rooms: [room("a", "L0", 2.5, 0), room("b", "L1", 3, 0.08)],
      openings: [{ id: "g", kind: "gap", at: [2, 0.08], width: 1, outside: { backdrop: "x" } }],
    };
    const { report } = runCheck(raw, { until: "openings" });
    expect(report.errors).toEqual([]);
    const g = passOf(report, "g");
    expect(g.rooms).toEqual(["b"]);
    expect(g.height).toBe(3);
  });

  test("test_shared_wall_opening_listed_on_both_edges", () => {
    const edges = flatReport.passport.edges as any[];
    expect(edges.find((e) => e.id === "living#3").openings).toEqual(["front"]);
    expect(edges.find((e) => e.id === "hall#0").openings).toEqual(["front"]);
  });

  test("test_on_opening_follows_snapped_axis", () => {
    // B's corner snaps onto A's [4,0]: its edge 0 rides the merged axis z = 0,
    // not the authored z = 0.06
    const room = (id: string, shape: number[][]): any => ({ id, level: "L0", height: 3, shape, floor: "m", ceiling: "m", walls: { material: "m" } });
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "a", at: [2, 2], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [room("a", [[0, 0], [4, 0], [4, 4], [0, 4]]), room("b", [[4.06, 0.06], [8, 0.06], [8, 4.06], [4.06, 4.06]])],
      openings: [{ id: "w", kind: "window", on: { room: "b", edge: 0, t: 0.3 }, width: 1, outside: { backdrop: "x" } }],
    };
    const { report } = runCheck(raw, { until: "openings" });
    expect(report.errors.filter((e) => e.path.startsWith("/openings"))).toEqual([]);
    const w = passOf(report, "w");
    expect(w.center[1]).toBeCloseTo(0, 3);
  });

  test("test_arc_flatten_keeps_neighbour_wall", () => {
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [
        { id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } },
        { id: "n", level: "L0", height: 3, shape: [[-2, 3.15], [2, 3.15], [2, 5], [-2, 5]], floor: "m", ceiling: "m", walls: { material: "m" } },
      ],
      openings: [{ id: "w", kind: "window", on: { room: "r", edge: 0, t: 0 }, width: 2, outside: { backdrop: "x" } }],
    };
    const { ctx } = runCheck(raw, { until: "openings" });
    const body = (ctx as any).levels.get("L0").body;
    // a strip inside n's wall band (3.09..3.21) stays solid
    const sq = [[-10, 3095], [10, 3095], [10, 3105], [-10, 3105]].map(([x, y]) => ({ x, y }));
    const left = Clipper.areaPaths(Clipper.intersect(body, [sq], 1));
    expect(left).toBeCloseTo(200, 0);
  });

  test("test_too_high_sill_over_ceiling_no_negative_fix", () => {
    const { report } = runCheck(patched([{ op: "replace", path: "/openings/1/sill", value: 4 }]), { until: "openings" });
    const e = report.errors.find((x) => x.code === "OPENING_TOO_HIGH")!;
    expect(e).toBeDefined();
    const h = (e.fix as any)?.height;
    if (h !== undefined) expect(h).toBeGreaterThan(0);
  });

  test("test_off_edge_past_authored_end", () => {
    // b's edge 0 is 3.94 long; the snapped interval reaches 4, the edge does not
    const room = (id: string, shape: number[][]): any => ({ id, level: "L0", height: 3, shape, floor: "m", ceiling: "m", walls: { material: "m" } });
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "a", at: [2, 2], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [room("a", [[0, 0], [4, 0], [4, 4], [0, 4]]), room("b", [[4.06, 0.06], [8, 0.06], [8, 4.06], [4.06, 4.06]])],
      openings: [{ id: "w", kind: "window", on: { room: "b", edge: 0, t: 1 }, width: 0.08, outside: { backdrop: "x" } }],
    };
    const { report } = runCheck(raw, { until: "openings" });
    expect(report.errors.map((e) => [e.code, e.path])).toContainEqual(["OPENING_OFF_EDGE", "/openings/0"]);
  });

  test("test_too_high_fix_stays_valid", () => {
    const { report } = runCheck(patched([
      { op: "replace", path: "/openings/1/sill", value: 3.3997 },
      { op: "replace", path: "/openings/1/height", value: 1 },
    ]), { until: "openings" });
    const e = report.errors.find((x) => x.code === "OPENING_TOO_HIGH")!;
    const h = (e.fix as any)?.height;
    if (h !== undefined) {
      expect(h).toBeGreaterThan(0);
      expect(3.3997 + h).toBeLessThanOrEqual(3.4);
    }
  });

  test("test_swing_room_must_be_a_side", () => {
    const { report } = runCheck(patched([
      { op: "replace", path: "/openings/1/kind", value: "door" },
      { op: "replace", path: "/openings/1/sill", value: 0 },
      { op: "replace", path: "/openings/1/height", value: 2.1 },
      { op: "add", path: "/openings/1/leaf", value: { decal: "d_sea", swing: "hall" } },
    ]), { until: "openings" });
    expect(report.errors.map((e) => [e.code, e.path])).toEqual([["REF_UNKNOWN", "/openings/1/leaf/swing"]]);
    expect(report.errors[0].msg).toContain("living");
    // the invalid door is out of the passport and cuts no wall
    expect((report.passport.openings as any[]).map((o) => o.id)).not.toContain("sea");
    // and does not block a valid window on the same wall
    const { report: r2 } = runCheck(patched([
      { op: "replace", path: "/openings/1/kind", value: "door" },
      { op: "replace", path: "/openings/1/sill", value: 0 },
      { op: "replace", path: "/openings/1/height", value: 2.1 },
      { op: "add", path: "/openings/1/leaf", value: { decal: "d_sea", swing: "hall" } },
      { op: "add", path: "/openings/-", value: { id: "w2", kind: "window", on: { room: "living", edge: 1, t: 0.5 }, width: 1, height: 1, sill: 1, outside: { backdrop: "d_sea" } } },
    ]), { until: "openings" });
    expect(r2.errors.map((e) => [e.code, e.path])).toEqual([["REF_UNKNOWN", "/openings/1/leaf/swing"]]);
  });

  test("test_too_high_within_eps", () => {
    const { report } = runCheck(patched([{ op: "replace", path: "/openings/0/height", value: 3.0000005 }]), { until: "openings" });
    expect(report.errors.map((e) => e.code)).not.toContain("OPENING_TOO_HIGH");
  });

  const splitCircle = (openings: any[]): any => ({
    version: 0, name: "t",
    spawn: { room: "r", at: [0, 0], yaw: 0 },
    materials: { m: { color: "#ffffff" } }, assets: { x: { kind: "decal", prompt: "x" } },
    levels: [{ id: "L0", y: 0 }],
    rooms: [
      { id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } },
      { id: "n", level: "L0", height: 3, shape: [[3, 0, { bulge: -1 }], [-3, 0], [-4, 5], [4, 5]], floor: "m", ceiling: "m", walls: { material: "m" } },
    ],
    openings,
  });

  test("test_at_opening_straddling_split_circle", () => {
    // [3, 0] is where the shared upper half meets r's exterior half
    const { report } = runCheck(splitCircle([{ id: "w", kind: "window", at: [3, 0], width: 1, height: 1, sill: 1, outside: { backdrop: "x" } }]), { until: "openings" });
    expect(report.errors.map((e) => [e.code, e.path])).toContainEqual(["OPENING_OFF_EDGE", "/openings/0"]);
  });

  test("test_shared_half_continuous_across_seam", () => {
    // t = 0 is +Z, in the middle of the shared upper half
    const { report } = runCheck(splitCircle([{ id: "d", kind: "arch", on: { room: "r", edge: 0, t: 0 }, width: 1 }]), { until: "openings" });
    expect(report.errors.filter((e) => e.path.startsWith("/openings"))).toEqual([]);
    expect((report.passport.openings as any[])[0].rooms).toEqual(["r", "n"]);
    // r#0 meets n over az -90..90: in r's own m that is [0, 3π/2] and [9π/2, 6π]
    const r0 = (report.passport.edges as any[]).find((e) => e.id === "r#0");
    expect(r0.sides).toEqual([{ room: "n", m: [0, 4.712] }, { room: "n", m: [14.137, 18.85] }]);
  });
});

