import { describe, it, expect } from "vitest";
import { findStageRoute, type StageLevel } from "../src/runtime/stage/path.js";
import { CELL, type NavLayer, type NavRamp } from "../src/nav/floor.js";

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
const rampAt = (y0: number, y1: number, fi: number, fj: number): NavRamp => ({
  stair: "s",
  y0,
  y1,
  axis: { from: [c(fi), c(fj)], dir: 90, len: 4 * CELL },
  poly: [],
});

describe("stage routes over the level graph (F7)", () => {
  it("test_stage_route_hops_through_middle_floor", () => {
    const l0 = level("L0", 0, 20, 20);
    const l1 = level("L1", 3, 20, 20);
    const l2 = level("L2", 6, 20, 20);
    const r = findStageRoute(
      [l0, l1, l2],
      [rampAt(0, 3, 2, 10), rampAt(3, 6, 12, 10)],
      [c(1), c(5)],
      "L0",
      [c(18), c(15)],
      "L2",
    );
    expect(r).not.toBeNull();
    expect(r!.yEnd).toBeCloseTo(6, 6);
    expect(r!.path[r!.path.length - 1]).toEqual([c(18), c(15)]);
  });
  it("test_stage_route_tries_next_ramp_when_first_is_blocked", () => {
    // full-width wall on L0 between the start (row 10) and the first ramp foot (row 4)
    const wall: Array<[number, number]> = [];
    for (let i = 0; i < 20; i++) {
      wall.push([i, 6]);
      wall.push([i, 7]);
      wall.push([i, 8]);
    }
    const l0 = level("L0", 0, 20, 20, wall);
    const l1 = level("L1", 3, 20, 20);
    const first = rampAt(0, 3, 2, 4);
    const second = rampAt(0, 3, 2, 14);
    const r = findStageRoute([l0, l1], [first, second], [c(1), c(10)], "L0", [c(18), c(14)], "L1");
    expect(r).not.toBeNull();
    expect(r!.yEnd).toBeCloseTo(3, 6);
    expect(r!.path[r!.path.length - 1]).toEqual([c(18), c(14)]);
  });
});
