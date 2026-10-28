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
    // the cut is the chord rectangle: 4 corners, chord ends unchanged, depth = thickness/2
    const path = cutPath(g);
    expect(path.length).toBe(4);
    const zc = (g.ends[0][1] + g.ends[1][1]) / 2;
    const xs = path.map((q: any) => Math.abs(q.x) / 1000).sort((a: number, b: number) => a - b);
    for (const x of xs) expect(x).toBeCloseTo(0.5, 3);
    const depths = path.map((q: any) => Math.abs(q.y / 1000 - zc)).sort((a: number, b: number) => a - b);
    for (const d of depths) expect(d).toBeCloseTo(g.thickness / 2, 3);
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
