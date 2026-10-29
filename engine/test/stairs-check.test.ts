import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/check.js";

const demoUrl = new URL("../../specs/examples/demo.scene.json", import.meta.url);

function demo(): any {
  return JSON.parse(readFileSync(demoUrl, "utf-8"));
}

describe("stairs check", () => {
  it("test_demo_check_ok", () => {
    const { report } = runCheck(demo());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.stages.find((s) => s.stage === "stairs")?.status).toBe("pass");

    const pass = (report.passport as any).stairs;
    expect(pass).toHaveLength(1);
    const up = pass[0];
    expect(up.id).toBe("up");
    expect(up.n).toBe(21);
    expect(up.rise).toBeCloseTo(0.171, 3);
    expect(up.len).toBeCloseTo(5.6, 3);
    expect(up.exit).toEqual([1.4, 6]);
    const xs = (up.cut as number[][]).map((p) => p[0]);
    const zs = (up.cut as number[][]).map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0.95, 3);
    expect(Math.max(...xs)).toBeCloseTo(1.85, 3);
    expect(Math.min(...zs)).toBeCloseTo(6, 3);
    expect(Math.max(...zs)).toBeCloseTo(10.247, 3);
  });

  it("test_stair_exit_outside", () => {
    const raw = demo();
    raw.stairs[0].from.at = [1.4, 9.0];
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_EXIT_OUTSIDE");
    expect(e).toBeDefined();
    expect(e!.stage).toBe("stairs");
    expect(e!.path).toBe("/stairs/0");
    expect(e!.msg).toContain("up");
    expect(e!.msg).toContain("(1.4, 3.4)");
    expect(e!.msg).toContain("loft");
  });

  it("test_stair_headroom", () => {
    const raw = demo();
    raw.rooms[2].shape = [
      [-2, 4],
      [2, 4],
      [2, 8],
      [-2, 8],
    ];
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
    expect(e!.stage).toBe("stairs");
    expect(e!.msg).toContain("1.353");
    expect(e!.msg).toContain("0.624");
  });

  it("test_stair_same_level_refused", () => {
    const raw = demo();
    raw.stairs[0].to.room = "living";
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_EXIT_OUTSIDE");
    expect(e).toBeDefined();
    expect(e!.stage).toBe("stairs");
    expect(e!.msg).toContain("up");
    expect(e!.msg).toContain("living");
    expect(JSON.stringify(report)).not.toContain("NaN");
    expect(JSON.stringify(report)).not.toContain("null,null");

    const dir = mkdtempSync(join(tmpdir(), "stairs-"));
    const scene = join(dir, "same-level.scene.json");
    writeFileSync(scene, JSON.stringify(raw));
    let code = 0;
    try {
      execFileSync(process.execPath, ["--import", "tsx", "bin/dreamer.ts", "check", scene, "--report", join(dir, "check.json")], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdio: "pipe",
      });
    } catch (err: any) {
      code = err.status;
    }
    expect(code).toBe(1);
  });

  it("test_future_stairs_gone", () => {
    const { report } = runCheck(demo());
    expect(report.errors.filter((e) => e.code === "SCHEMA_FUTURE_FIELD")).toEqual([]);
  });

  it("test_stair_ref_unknown_room", () => {
    const raw = demo();
    raw.stairs[0].from.room = "nope";
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "REF_UNKNOWN" && i.path === "/stairs/0/from/room");
    expect(e).toBeDefined();
  });

  it("test_stair_id_duplicate", () => {
    const raw = demo();
    raw.stairs.push({ ...JSON.parse(JSON.stringify(raw.stairs[0])) });
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "ID_DUPLICATE" && i.path === "/stairs/1/id");
    expect(e).toBeDefined();
  });

  it("test_stair_exit_inside_circle_room", () => {
    const raw = demo();
    // tall enough that headroom never becomes the binding constraint here;
    // this case isolates the exit-membership check against a curved boundary
    raw.rooms[1].height = 6.0;
    raw.rooms[2] = {
      id: "loft",
      level: "L1",
      height: 2.8,
      circle: { c: [0, 0], r: 6.16217872 },
      floor: "parquet",
      ceiling: "white",
      walls: { material: "white" },
    };
    const { report } = runCheck(raw);
    expect(report.errors.find((i) => i.code === "STAIR_EXIT_OUTSIDE")).toBeUndefined();
    expect(report.stages.find((s) => s.stage === "stairs")?.status).toBe("pass");
  });

  it("test_stair_headroom_from_beam", () => {
    const raw = demo();
    raw.rooms[1].beams = [{ from: [1.4, 10.7], to: [1.4, 11.1], material: "wood", w: 0.25, h: 0.5 }];
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("test_stair_headroom_from_beam_under_slab_cut", () => {
    const raw = demo();
    // this beam sits where the stair axis already runs under `to.room`
    // (the slab there gets cut away), but the beam itself hangs from the
    // lower room's own ceiling and the cut does not remove it
    raw.rooms[1].beams = [{ from: [1.4, 10.0], to: [1.4, 10.2], material: "wood", w: 0.25, h: 0.5 }];
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("test_stair_headroom_from_toroom_beam", () => {
    const raw = demo();
    // this beam hangs from loft's own ceiling but is tall enough (h: 3.5 on a
    // 2.8m-high room) to poke through loft's floor into the stairwell below
    raw.rooms[2].beams = [{ from: [1.4, 10], to: [1.4, 10.2], material: "wood", w: 0.25, h: 3.5 }];
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("test_stair_headroom_from_offset_beam", () => {
    const raw = demo();
    // the flight is 0.9 wide (x 0.95..1.85); this beam covers x 0.875..1.125,
    // so it hangs over the left half of the stair but misses its centreline
    raw.rooms[1].beams = [{ from: [1.0, 10.7], to: [1.0, 11.1], material: "wood", w: 0.25, h: 0.5 }];
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("test_stair_cut_does_not_bridge_notch", () => {
    const raw = demo();
    // loft footprint has a notch cut out between z=8 and z=10 on the side
    // the stair runs through; the slab cut must not jump across that gap
    raw.rooms[2].shape = [
      [-2, 4],
      [2, 4],
      [2, 12],
      [-2, 12],
      [-2, 10],
      [1.8, 10],
      [1.8, 8],
      [-2, 8],
    ];
    const { report } = runCheck(raw);
    const up = (report.passport as any).stairs[0];
    const zs = (up.cut as number[][]).map((p) => p[1]);
    // the cut must stay within the under-loft span touching the exit, not
    // bridge the notch gap (z 8..10) where the loft has no slab at all
    expect(Math.min(...zs)).toBeCloseTo(6, 3);
    expect(Math.max(...zs)).toBeCloseTo(8, 3);
  });

  it("test_stair_notch_stranded_span_in_headroom", () => {
    const raw = demo();
    // same notch: the flight runs under loft again for z 10..10.247 (s 1.353..1.6),
    // but that piece is cut off from the exit by the notch, so its slab stays
    // whole and the headroom interval has to start at s = 1.353, not at the notch
    raw.rooms[2].shape = [
      [-2, 4],
      [2, 4],
      [2, 12],
      [-2, 12],
      [-2, 10],
      [1.8, 10],
      [1.8, 8],
      [-2, 8],
    ];
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
    expect(e!.msg).toContain("[1.353, 3.6]");
  });

  it("test_stair_cut_needs_whole_tread_under_to_room", () => {
    const raw = demo();
    // loft ends at x = 1.6: the axis (x = 1.4) is under it, the right edge of
    // the 0.9-wide flight (x = 1.85) is not, so there is no slab to cut over
    // x 1.6..1.85 and the hall ceiling there leaves < 2 m
    raw.rooms[2].shape = [
      [-2, 4],
      [1.6, 4],
      [1.6, 10.5],
      [-2, 10.5],
    ];
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
    expect(report.ok).toBe(false);
    const up = (report.passport as any).stairs[0];
    for (const p of (up.cut ?? []) as number[][]) expect(p[0]).toBeLessThanOrEqual(1.6 + 1e-6);
  });

  it("test_spawn_level_empty_id_still_checked", () => {
    const raw = demo();
    raw.levels[0].id = "";
    for (const r of raw.rooms) if (r.level === "L0") r.level = "";
    raw.spawn.room = "hall";
    raw.rooms.push({
      id: "closet",
      level: "",
      height: 2.4,
      shape: [
        [20, 20],
        [21, 20],
        [21, 21],
        [20, 21],
      ],
      floor: "parquet",
      ceiling: "white",
      walls: { material: "white" },
    });
    const { report } = runCheck(raw);
    const e = report.errors.find((i) => i.code === "ROOM_UNREACHABLE" && i.path?.endsWith(String(raw.rooms.length - 1)));
    expect(e).toBeDefined();
  });

  it("test_stair_still_passes_with_empty_spawn_level_id", () => {
    const raw = demo();
    raw.levels[0].id = "";
    for (const r of raw.rooms) if (r.level === "L0") r.level = "";
    const { report } = runCheck(raw);
    expect(report.ok).toBe(true);
    expect(report.stages.find((s: any) => s.stage === "stairs")?.status).toBe("pass");
  });
});
