import { describe, expect, beforeAll, test } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";
import { round3 } from "../src/report/report.js";
import { arcFromBulge } from "../src/geom/arc.js";
import { demoFlat, patched } from "./helpers/scene.js";
import type { Report } from "../src/types.js";

let flatReport: Report;
let flatCtx: any;

beforeAll(() => {
  const out = runCheck(demoFlat());
  flatReport = out.report;
  flatCtx = out.ctx;
});

function edgeOf(ctx: any, id: string): any {
  return ctx.rooms.flatMap((r: any) => r.edges).find((e: any) => e.id === id);
}

function loneRoomScene(shapeOrCircle: unknown, roomId = "t"): unknown {
  const room: any = {
    id: roomId,
    level: "L0",
    height: 3,
    floor: "parquet",
    ceiling: "white",
    walls: { material: "white" },
  };
  if (Array.isArray(shapeOrCircle)) room.shape = shapeOrCircle;
  else room.circle = shapeOrCircle;
  return patched([
    { op: "replace", path: "/rooms", value: [room] },
    { op: "replace", path: "/openings", value: [] },
    { op: "replace", path: "/props", value: [] },
    { op: "replace", path: "/decals", value: [] },
    { op: "replace", path: "/routes", value: [] },
    { op: "replace", path: "/cameras", value: [] },
    { op: "replace", path: "/spawn", value: { room: roomId, at: [0, 0], yaw: 0 } },
  ]);
}

describe("rooms", () => {
  test("demo-flat edges", () => {
    expect(flatReport.errors).toEqual([]);
    const e1 = edgeOf(flatCtx, "living#1");
    expect(e1.arc.c[0]).toBeCloseTo(0, 6);
    expect(e1.arc.c[1]).toBeCloseTo(0.2, 6);
    expect(e1.arc.r).toBeCloseTo(5.8, 6);
    expect(round3(e1.len)).toBe(8.828);
    const e3 = edgeOf(flatCtx, "living#3");
    expect(e3.from).toEqual([4, 4]);
    expect(e3.to).toEqual([-4, 4]);
    expect(e3.normalIn).toEqual([0, -1]);
  });

  test("two arcs share one wall without overlap", () => {
    const raw = patched([
      {
        op: "replace",
        path: "/rooms",
        value: [
          {
            id: "A",
            level: "L0",
            height: 3,
            shape: [[3, 0, { bulge: 1 }], [-3, 0], [-3, -4], [3, -4]],
            floor: "parquet",
            ceiling: "white",
            walls: { material: "white" },
          },
          {
            id: "B",
            level: "L0",
            height: 3,
            shape: [[-3, 0, { bulge: -1 }], [3, 0], [3, 6], [-3, 6]],
            floor: "parquet",
            ceiling: "white",
            walls: { material: "white" },
          },
        ],
      },
      {
        op: "replace",
        path: "/openings",
        value: [{ id: "d", kind: "door", on: { room: "A", edge: 0, t: 0.5 }, width: 0.9, height: 2.1, sill: 0 }],
      },
      { op: "replace", path: "/props", value: [] },
      { op: "replace", path: "/decals", value: [] },
      { op: "replace", path: "/routes", value: [] },
      { op: "replace", path: "/cameras", value: [] },
      { op: "replace", path: "/spawn", value: { room: "A", at: [0, -2], yaw: 0 } },
    ]);
    const { report, ctx } = runCheck(raw, { until: "plan" });
    expect(report.errors.filter((e) => e.code === "ROOMS_OVERLAP")).toEqual([]);
    for (const id of ["A#0", "B#0"]) {
      const e = edgeOf(ctx, id);
      expect(e.arc.c[0]).toBeCloseTo(0, 6);
      expect(e.arc.c[1]).toBeCloseTo(0, 6);
      expect(e.arc.r).toBeCloseTo(3, 6);
    }
    const apex = arcFromBulge([3, 0], [-3, 0], 1, [0, -1]).apex;
    expect(apex[0]).toBeCloseTo(0, 6);
    expect(apex[1]).toBeCloseTo(3, 6);
  });

  test("broken plan codes", () => {
    for (const code of ["ROOMS_OVERLAP", "ROOM_SELF_INTERSECT"]) {
      const ops = JSON.parse(
        readFileSync(new URL(`./scenes/broken/${code}.patch.json`, import.meta.url), "utf-8"),
      );
      const { report } = runCheck(patched(ops));
      expect(report.errors.map((e) => e.code)).toEqual([code]);
      expect(report.warnings).toEqual([]);
    }
  });

  test("circle room is a single closed arc edge", () => {
    const { report, ctx } = runCheck(loneRoomScene({ c: [0, 0], r: 3 }, "r"), { until: "plan" });
    expect(report.errors).toEqual([]);
    const edges = ctx.rooms![0].edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe("r#0");
    expect(edges[0].arc.r).toBeCloseTo(3, 6);
    expect(round3(edges[0].len)).toBe(18.85);
    expect(edges[0].from).toEqual([0, 3]);
  });

  test("az on arc validated against arc span", () => {
    const bad = patched([
      { op: "replace", path: "/decals/0/on", value: { room: "living", edge: 1, az: 90 } },
    ]);
    const badRep = runCheck(bad).report;
    expect(badRep.errors.map((e) => `${e.stage}:${e.code}`)).toEqual(["schema:POS_INVALID"]);
    const ok = patched([
      { op: "replace", path: "/decals/0/on", value: { room: "living", edge: 1, az: 160 } },
    ]);
    expect(runCheck(ok).report.errors).toEqual([]);
  });

  test("degenerate edge is an issue, not a crash", () => {
    for (const shape of [
      [[0, 0], [4, 0], [4, 0], [4, 4], [0, 4]],
      [[0, 0], [4, 0, { bulge: 0.5 }], [4, 0], [4, 4], [0, 4]],
    ]) {
      const { report } = runCheck(loneRoomScene(shape), { until: "plan" });
      expect(report.errors.map((e) => e.code)).toEqual(["ROOM_SELF_INTERSECT"]);
      expect(report.errors[0].path).toBe("/rooms/0/shape/1");
    }
  });

  test("winding does not change inward normals", () => {
    const ccw = runCheck(loneRoomScene([[0, 0], [4, 0], [4, 4], [0, 4]], "sq"), { until: "plan" }).ctx;
    const cw = runCheck(loneRoomScene([[0, 0], [0, 4], [4, 4], [4, 0]], "sq"), { until: "plan" }).ctx;
    const atZ0 = (ctx: any) => ctx.rooms![0].edges.find((e: any) => e.from[1] === 0 && e.to[1] === 0);
    expect(atZ0(ccw).normalIn).toEqual([0, 1]);
    expect(atZ0(cw).normalIn).toEqual([0, 1]);
    expect(ccw.rooms![0].edges.map((e: any) => e.id)).toEqual(["sq#0", "sq#1", "sq#2", "sq#3"]);
    expect(cw.rooms![0].edges.map((e: any) => e.id)).toEqual(["sq#0", "sq#1", "sq#2", "sq#3"]);
  });

  test("circle overlap, circle mid-arc normal, self-intersect msg room id", () => {
    const raw = patched([
      {
        op: "replace",
        path: "/rooms",
        value: [
          {
            id: "C",
            level: "L0",
            height: 3,
            circle: { c: [0, 0], r: 3 },
            floor: "parquet",
            ceiling: "white",
            walls: { material: "white" },
          },
          {
            id: "B",
            level: "L0",
            height: 3,
            shape: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
            floor: "parquet",
            ceiling: "white",
            walls: { material: "white" },
          },
        ],
      },
      { op: "replace", path: "/openings", value: [] },
      { op: "replace", path: "/props", value: [] },
      { op: "replace", path: "/decals", value: [] },
      { op: "replace", path: "/routes", value: [] },
      { op: "replace", path: "/cameras", value: [] },
      { op: "replace", path: "/spawn", value: { room: "B", at: [0, 0], yaw: 0 } },
    ]);
    const { report, ctx } = runCheck(raw, { until: "plan" });
    expect(report.errors.map((e) => e.code)).toEqual(["ROOMS_OVERLAP"]);
    const circle = ctx.rooms!.find((r: any) => r.id === "C")!;
    expect(circle.outline.length).toBeGreaterThan(8);
    expect(circle.edges[0].normalIn).toEqual([0, 1]);
    const bad = runCheck(loneRoomScene([[0, 0], [4, 0], [4, 0], [4, 4], [0, 4]], "sq"), { until: "plan" }).report;
    expect(bad.errors.map((e) => e.code)).toEqual(["ROOM_SELF_INTERSECT"]);
    expect(bad.errors[0].msg).toContain('"sq"');
  });

  test("contract fixes: circle tessellation and author edge addresses", () => {
    const circ = runCheck(loneRoomScene({ c: [0, 0], r: 3 }, "r"), { until: "plan" }).ctx;
    expect(circ.rooms![0].outline.length).toBe(76);
    const bow = runCheck(loneRoomScene([[-2, 4, { bulge: 0.5 }], [2, 12], [2, 4], [-2, 12]], "sq"), {
      until: "plan",
    }).report;
    expect(bow.errors.map((e) => e.code)).toEqual(["ROOM_SELF_INTERSECT"]);
    expect(bow.errors[0].msg).toContain('"sq"');
    expect(bow.errors[0].msg).toContain("sq#0");
    expect(bow.errors[0].msg).toContain("sq#3");
    expect(bow.errors[0].msg).not.toContain("21");
  });
});
