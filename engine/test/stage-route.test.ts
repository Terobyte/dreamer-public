import { describe, it, expect } from "vitest";
import { findStageRoute, type StageLevel } from "../src/runtime/stage/path.js";
import { floorAt } from "../src/runtime/stage/places.js";
import { CELL, type NavLayer, type NavRamp } from "../src/nav/floor.js";
import { createActor } from "../src/runtime/stage/actors.js";

/** w x h cells of CELL m; `blocked` cells are walls. */
function level(levelName: string, y: number, w: number, h: number, blocked: Array<[number, number]> = []): StageLevel {
  const bits = new Uint8Array(Math.ceil((w * h) / 8));
  const set = (i: number, j: number, on: boolean) => {
    const n = j * w + i;
    if (on) bits[n >> 3] |= 1 << (n & 7);
    else bits[n >> 3] &= ~(1 << (n & 7));
  };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(i, j, true);
  for (const [i, j] of blocked) set(i, j, false);
  const layer = { level: levelName, y, origin: [0, 0], w, h } as unknown as NavLayer;
  return { layer, bits, y };
}
const c = (i: number): number => (i + 0.5) * CELL;
const ramp = (y0: number, y1: number): NavRamp => ({
  stair: "s",
  y0,
  y1,
  axis: { from: [c(2), c(10)], dir: 90, len: 4 * CELL },
  poly: [],
});

describe("stage routes across levels (F1/F2)", () => {
  it("test_stage_route_blocked_means_null_no_direct_walk", () => {
    const wall: Array<[number, number]> = [];
    for (let j = 0; j < 20; j++) wall.push([10, j]);
    const l0 = level("L0", 0, 20, 20, wall);
    // F1: an unreachable goal stays unreachable — the caller must not walk straight at it.
    expect(findStageRoute([l0], [], [c(2), c(5)], "L0", [c(18), c(5)], "L0")).toBeNull();
  });
  it("test_stage_route_climbs_ramp_to_target_level", () => {
    const l0 = level("L0", 0, 20, 20);
    const l1 = level("L1", 3, 20, 20);
    const r = findStageRoute([l0, l1], [ramp(0, 3)], [c(1), c(10)], "L0", [c(8), c(10)], "L1");
    expect(r).not.toBeNull();
    expect(r!.yEnd).toBeCloseTo(3, 6);
    expect(r!.path[r!.path.length - 1]).toEqual([c(8), c(10)]);
  });
  it("test_stage_route_null_when_ramp_leg_blocked", () => {
    const l0 = level("L0", 0, 20, 20);
    const wall: Array<[number, number]> = [];
    for (let j = 0; j < 20; j++) wall.push([7, j]); // between the ramp exit (cell 6) and the goal (cell 8)
    const l1 = level("L1", 3, 20, 20, wall);
    expect(findStageRoute([l0, l1], [ramp(0, 3)], [c(1), c(10)], "L0", [c(8), c(10)], "L1")).toBeNull();
  });
});

describe("stage floor follows the actor level (F3)", () => {
  const outline: [[number, number], [number, number], [number, number], [number, number]] = [[0, 0], [5, 0], [5, 5], [0, 5]];
  const floors = [
    { room: "living", level: "L0", outline },
    { room: "bedroom", level: "L1", outline },
  ];
  it("test_stage_floor_overlapping_outlines_pick_actor_level", () => {
    expect(floorAt(floors, [2, 2], "L1")?.room).toBe("bedroom");
    expect(floorAt(floors, [2, 2], "L0")?.room).toBe("living");
  });
  it("test_stage_floor_no_level_keeps_first_match", () => {
    expect(floorAt(floors, [2, 2])?.room).toBe("living");
    expect(floorAt(floors, [9, 9], "L1")).toBeNull();
  });
});

describe("stage actor climbs to the target level (F2)", () => {
  it("test_stage_actor_height_reaches_target_level", async () => {
    const a = await createActor("t", "invalid://nope.glb", 1.7, [0, 0], 0);
    expect(a.y()).toBeCloseTo(0, 6);
    a.go([[3, 0]], 0, "idle", 3);
    for (let k = 0; k < 500; k++) a.update(1 / 60, k / 60);
    const [x, z] = a.pos();
    expect(Math.hypot(x - 3, z)).toBeLessThanOrEqual(0.3);
    expect(a.y()).toBeCloseTo(3, 1);
  });
});
