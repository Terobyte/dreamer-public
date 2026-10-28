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
