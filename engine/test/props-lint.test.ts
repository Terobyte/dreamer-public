import { describe, expect, beforeAll, test } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";
import { demoFlat, patched } from "./helpers/scene.js";
import type { Issue, Report } from "../src/types.js";

type Op = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

function stageIssues(r: Report): Issue[] {
  return [...r.errors, ...r.warnings].filter((i) => i.stage === "props");
}

function run(ops: Op[]): Report {
  return runCheck(patched(ops), { until: "props" }).report;
}

function patchOf(dir: string, code: string): Op[] {
  return JSON.parse(readFileSync(new URL(`./scenes/${dir}/${code}.patch.json`, import.meta.url), "utf-8"));
}

let flat: Report;

beforeAll(() => {
  flat = runCheck(demoFlat(), { until: "props" }).report;
});

describe("props lint", () => {
  test("test_demo_flat_props_clean", () => {
    expect(stageIssues(flat)).toEqual([]);
  });

  test("test_touching_not_hit", () => {
    // back face of the sofa lands exactly on the inner face x = -3.94
    const sofa = run([{ op: "replace", path: "/props/2/at", value: [-3.49, 1.5] }]);
    expect(stageIssues(sofa)).toEqual([]);
    // chair footprint touches the table footprint at 0.55
    const chair = run([{ op: "replace", path: "/props/1/around/r", value: 0.8 }]);
    expect(stageIssues(chair).map((i) => i.code)).toEqual([]);
  });

  test("test_wall_mount_arc", () => {
    const ops: Op[] = [
      {
        op: "add",
        path: "/props/-",
        value: {
          id: "shelf",
          asset: "p_table",
          room: "living",
          on: { room: "living", edge: 1, t: 0.3 },
          y: 1.2,
          size: { w: 1.0, d: 0.3, h: 0.5 },
          mount: "wall",
        },
      },
    ];
    const { report, ctx } = runCheck(patched(ops), { until: "props" });
    expect(stageIssues(report)).toEqual([]);
    const shelf = (ctx.props as Array<{ id: string; wall: string | null }>).find((p) => p.id === "shelf");
    expect(shelf?.wall).toBe("living#1");
  });

  test("test_broken_prop_codes", () => {
    const codes = [
      "PROP_HITS_WALL",
      "PROP_HITS_PROP",
      "PROP_IN_DOORWAY",
      "PROP_IN_SWING",
      "PROP_OUTSIDE_ROOM",
      "PROP_NO_FACING",
      "PROP_ON_TOO_SMALL",
      "PROP_CEILING_LOW",
      "PROP_ABOVE_CEILING",
      "PROP_WALL_NOT_FOUND",
    ];
    for (const code of codes) {
      const report = run(patchOf("broken", code));
      expect(report.errors.map((e) => e.code), code).toEqual([code]);
      expect(report.warnings, code).toEqual([]);
    }

    const wall = run(patchOf("broken", "PROP_HITS_WALL")).errors[0];
    expect(wall.fix).toEqual({ at: [-3.48, 1.5] });
    expect(wall.msg).toContain("living#0");
    expect(wall.msg).toContain("0.18");

    const facing = run(patchOf("broken", "PROP_NO_FACING")).errors[0];
    expect(facing.fix).toEqual({ face: "room" });

    const above = run(patchOf("broken", "PROP_ABOVE_CEILING")).errors[0];
    expect(above.msg).toContain("3.2");
    expect(above.msg).toContain("3");
  });

  test("test_prop_warnings", () => {
    const odd = run(patchOf("warn", "PROP_SIZE_ODD"));
    expect(odd.errors).toEqual([]);
    expect(odd.warnings.map((w) => w.code)).toEqual(["PROP_SIZE_ODD"]);

    const stool = (h: number): Op[] => [
      {
        op: "add",
        path: "/props/-",
        value: {
          id: "stool",
          asset: "p_chair",
          cat: "chair",
          room: "living",
          at: [2.5, -2],
          size: { w: 0.5, d: 0.5, h },
          yaw: 0,
        },
      },
    ];
    expect(run(stool(1.55)).warnings).toEqual([]);
    expect(run(stool(1.65)).warnings.map((w) => w.code)).toEqual(["PROP_SIZE_ODD"]);

    const far = run(patchOf("warn", "FACE_ROOM_FAR"));
    expect(far.errors).toEqual([]);
    expect(far.warnings.map((w) => w.code)).toEqual(["FACE_ROOM_FAR"]);
  });

  test("test_around_copy_path", () => {
    const report = run([
      { op: "replace", path: "/props/1/around", value: { center: "table", n: 1, r: 3.8, start: 270 } },
    ]);
    expect(report.errors.map((e) => e.code)).toEqual(["PROP_HITS_WALL"]);
    const e = report.errors[0];
    expect(e.path).toBe("/props/1");
    expect(e.copy).toBe(0);
    expect("copy" in e).toBe(true);
    expect(e.fix).toBeUndefined();
  });
});

describe("terra re-review", () => {
  const box = (id: string, room: string, at: number[], size: any): any =>
    ({ id, asset: "p_table", cat: "table", room, at, size, yaw: 0, solid: true });

  test("test_hits_wall_below_window_sill", () => {
    // the sea window cuts living#1 only from 1 m up: a 0.5 m box still meets the wall
    const r = run([{ op: "add", path: "/props/-", value: box("low", "living", [0, -5.5], { w: 0.3, d: 0.4, h: 0.5 }) }]);
    expect(stageIssues(r).map((i) => i.code)).toContain("PROP_HITS_WALL");
  });

  test("test_hits_wall_reports_struck_wall", () => {
    // a long box's far end goes into hall#2 (z = 12), not into the side wall
    // nearest its centre; the fix must clear it
    const r = run([{ op: "add", path: "/props/-", value: box("long", "hall", [0, 8.7], { w: 0.2, d: 7, h: 0.5 }) }]);
    const e = stageIssues(r).find((i) => i.code === "PROP_HITS_WALL")!;
    expect(e.msg).toContain("hall#2");
    const at = (e.fix as any).at;
    const r2 = run([{ op: "add", path: "/props/-", value: box("long", "hall", at, { w: 0.2, d: 7, h: 0.5 }) }]);
    expect(stageIssues(r2).map((i) => i.code)).not.toContain("PROP_HITS_WALL");
  });

  test("test_face_room_far_without_at", () => {
    const r = run([{ op: "add", path: "/props/-", value: { id: "pot", asset: "p_vase", cat: "vase", room: "living", mount: { top_of: "table" }, size: { w: 0.2, d: 0.2, h: 0.3 }, face: "room", solid: false } }]);
    expect(stageIssues(r).map((i) => i.code)).toContain("FACE_ROOM_FAR");
  });

  test("test_no_facing_is_the_only_record", () => {
    const r = run([
      { op: "remove", path: "/props/2/face" },
      { op: "replace", path: "/props/2/size/h", value: 4 },
    ]);
    expect(stageIssues(r).filter((i) => i.path.startsWith("/props/2")).map((i) => i.code)).toEqual(["PROP_NO_FACING"]);
  });

  test("test_hits_curved_wall_fix_clears", () => {
    // the box's corners reach the bulging living#1 deeper than its centre line does
    const r = run([{ op: "add", path: "/props/-", value: box("wide", "living", [0, -5.4], { w: 2, d: 0.5, h: 0.5 }) }]);
    const e = stageIssues(r).find((i) => i.code === "PROP_HITS_WALL" && i.path === "/props/5/at")!;
    const r2 = run([{ op: "add", path: "/props/-", value: box("wide", "living", (e.fix as any).at, { w: 2, d: 0.5, h: 0.5 }) }]);
    expect(stageIssues(r2).filter((i) => i.path.startsWith("/props/5")).map((i) => i.code)).not.toContain("PROP_HITS_WALL");
  });

  test("test_above_ceiling_heights_same_frame", () => {
    const r = run([
      { op: "replace", path: "/levels/0/y", value: 10 },
      { op: "add", path: "/props/-", value: { id: "tall", asset: "p_table", cat: "wardrobe", room: "hall", at: [0, 8], size: { w: 1, d: 0.5, h: 3.2 }, yaw: 0, solid: false } },
    ]);
    const e = stageIssues(r).find((i) => i.code === "PROP_ABOVE_CEILING")!;
    expect(e.msg).toContain("3.2 м");
    expect(e.msg).not.toContain("13.2");
  });

  test("test_ceiling_prop_above_door_not_in_swing", () => {
    const r = run([{ op: "add", path: "/props/-", value: { id: "lamp2", asset: "p_table", cat: "lamp", room: "living", at: [0, 3.12], mount: "ceiling", size: { w: 0.3, d: 0.1, h: 0.5 }, yaw: 0, solid: true } }]);
    expect(stageIssues(r).filter((i) => i.path.startsWith("/props/5")).map((i) => i.code)).not.toContain("PROP_IN_SWING");
  });
});

