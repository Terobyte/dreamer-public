import { describe, expect, beforeAll, test } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";
import { demoFlat, patched } from "./helpers/scene.js";
import type { DecalGeo, Issue, Report } from "../src/types.js";

type Op = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

const STAGES = new Set(["decals", "cameras"]);

function stageIssues(r: Report): Issue[] {
  return [...r.errors, ...r.warnings].filter((i) => STAGES.has(i.stage));
}

function run(ops: Op[]): Report {
  return runCheck(patched(ops), { until: "cameras" }).report;
}

function patchOf(dir: string, code: string): Op[] {
  return JSON.parse(readFileSync(new URL(`./scenes/${dir}/${code}.patch.json`, import.meta.url), "utf-8"));
}

let flat: Report;
let flatDecals: DecalGeo[];

beforeAll(() => {
  const r = runCheck(demoFlat(), { until: "cameras" });
  flat = r.report;
  flatDecals = (r.ctx.decals ?? []) as DecalGeo[];
});

describe("decals and cameras", () => {
  test("test_demo_flat_decal", () => {
    expect(stageIssues(flat)).toEqual([]);
    const d = flatDecals[0];
    expect(d.edge).toBe("living#2");
    expect(d.center[0]).toBeCloseTo(3.92, 6);
    expect(d.center[1]).toBeCloseTo(1.7, 6);
    expect(d.center[2]).toBeCloseTo(-1.6, 6);
    expect(d.normal[0]).toBeCloseTo(-1, 6);
    expect(d.normal[1]).toBeCloseTo(0, 6);
    expect(d.mRange[0]).toBeCloseTo(2.1, 6);
    expect(d.mRange[1]).toBeCloseTo(2.7, 6);
    expect(flat.passport.decals).toEqual([
      { i: 0, edge: "living#2", center: [3.92, 1.7, -1.6], normal: [-1, 0] },
    ]);
  });

  test("test_broken_decal_camera_codes", () => {
    for (const code of ["DECAL_OFF_WALL", "DECAL_ON_OPENING", "DECAL_OVERLAP", "CAMERA_OUTSIDE"]) {
      const r = run(patchOf("broken", code));
      expect(r.errors.map((i) => i.code), code).toEqual([code]);
      expect(r.warnings, code).toEqual([]);
    }
    const off = run(patchOf("broken", "DECAL_OFF_WALL"));
    expect(off.errors[0].fix).toEqual({ y: 3.05 });

    // outside every room, and inside a beam, are both CAMERA_OUTSIDE
    for (const pos of [
      [0, 1.6, 20],
      [0, 3.2, 0],
    ]) {
      const r = run([{ op: "replace", path: "/cameras/0/pos", value: pos }]);
      expect(r.errors.map((i) => i.code), JSON.stringify(pos)).toEqual(["CAMERA_OUTSIDE"]);
    }
    // above the table, not in it
    const above = run([{ op: "replace", path: "/cameras/0/pos", value: [0, 1.6, 0] }]);
    expect(stageIssues(above)).toEqual([]);
  });

  test("test_decal_hidden", () => {
    const r = run(patchOf("warn", "DECAL_HIDDEN"));
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((i) => i.code)).toEqual(["DECAL_HIDDEN"]);
  });

  test("test_decal_on_opening_shared_wall", () => {
    // decal authored on hall#0 must still catch the "front" opening, which
    // lives on the other side of the shared wall (living's own edge)
    const r = run([
      {
        op: "add",
        path: "/decals/-",
        value: {
          asset: "d_portrait",
          room: "hall",
          on: { room: "hall", edge: 0, t: 0.5 },
          y: 1.5,
          size: { w: 0.6, h: 0.6 },
        },
      },
    ]);
    expect(r.errors.map((i) => i.code)).toEqual(["DECAL_ON_OPENING"]);
  });

  test("test_camera_in_wall_above_opening", () => {
    // the front door is only open up to its own height; above that the
    // wall body still blocks, even though the flattened 2D plan has a hole
    const r = run([{ op: "replace", path: "/cameras/0/pos", value: [0, 2.8, 4.02] }]);
    expect(r.errors.map((i) => i.code)).toEqual(["CAMERA_OUTSIDE"]);
  });

  test("test_camera_picks_room_by_height", () => {
    const ops: Op[] = [
      { op: "add", path: "/levels/-", value: { id: "L1", y: 3.6 } },
      {
        op: "add",
        path: "/rooms/-",
        value: {
          id: "living2",
          level: "L1",
          height: 3.4,
          shape: [
            [-4, 4],
            [-4, -4],
            [4, -4],
            [4, 4],
          ],
          floor: "parquet",
          ceiling: "plaster",
          walls: { material: "olive" },
        },
      },
      { op: "add", path: "/cameras/-", value: { id: "camUp", pos: [0, 4, 0] } },
    ];
    const r = run(ops);
    expect(r.errors.some((i) => i.msg.includes("camUp"))).toBe(false);
  });
});

describe("decal overlap across the t=0 seam on a closed edge", () => {
  test("test_decal_overlap_circle_seam", () => {
    const raw: any = {
      version: 0,
      name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } },
      assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      decals: [
        { asset: "x", room: "r", on: { room: "r", edge: 0, t: 0 }, y: 1, size: { w: 1, h: 0.6 } },
        { asset: "x", room: "r", on: { room: "r", edge: 0, t: 0.99 }, y: 1, size: { w: 1, h: 0.6 } },
      ],
    };
    const { report } = runCheck(raw, { until: "decals" });
    expect(report.errors.map((i) => i.code)).toEqual(["DECAL_OVERLAP"]);
  });

  test("test_decal_and_window_opposite_sides_no_overlap", () => {
    const raw: any = {
      version: 0,
      name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } },
      assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      decals: [{ asset: "x", room: "r", on: { room: "r", edge: 0, t: 0 }, y: 1, size: { w: 0.6, h: 0.6 } }],
      openings: [{ id: "w", kind: "window", on: { room: "r", edge: 0, t: 0.5 }, width: 1.0, outside: { backdrop: "x" } }],
    };
    const { report } = runCheck(raw, { until: "decals" });
    expect(report.errors.map((i) => i.code)).toEqual([]);
  });

  test("test_decal_decal_opposite_sides_no_overlap", () => {
    const raw: any = {
      version: 0,
      name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } },
      assets: { x: { kind: "decal", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      decals: [
        { asset: "x", room: "r", on: { room: "r", edge: 0, t: 0 }, y: 1, size: { w: 0.6, h: 0.6 } },
        { asset: "x", room: "r", on: { room: "r", edge: 0, t: 0.5 }, y: 1, size: { w: 0.6, h: 0.6 } },
      ],
    };
    const { report } = runCheck(raw, { until: "decals" });
    expect(report.errors.map((i) => i.code)).toEqual([]);
  });

  test("test_decal_hidden_across_seam", () => {
    const raw: any = {
      version: 0,
      name: "t",
      spawn: { room: "r", at: [0, 0], yaw: 0 },
      materials: { m: { color: "#ffffff" } },
      assets: { x: { kind: "decal", prompt: "x" }, p: { kind: "object", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, circle: { c: [0, 0], r: 3 }, floor: "m", ceiling: "m", walls: { material: "m" } }],
      decals: [{ asset: "x", room: "r", on: { room: "r", edge: 0, t: 0 }, y: 1, size: { w: 1, h: 0.6 } }],
      props: [
        {
          id: "cab",
          asset: "p",
          cat: "table",
          room: "r",
          on: { room: "r", edge: 0, t: 0.97 },
          size: { w: 0.4, d: 0.4, h: 0.6 },
          mount: "wall",
          y: 0.8,
        },
      ],
    };
    const { report } = runCheck(raw, { until: "decals" });
    expect(report.errors).toEqual([]);
    expect(stageIssues(report).map((i) => i.code)).toEqual(["DECAL_HIDDEN"]);
  });
});
