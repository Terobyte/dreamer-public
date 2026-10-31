import { describe, it, expect } from "vitest";
import { findPath } from "../src/runtime/stage/path.js";
import { CELL } from "../src/nav/floor.js";

/** w x h cells of CELL m; `blocked` cells are walls. */
function grid(w: number, h: number, blocked: Array<[number, number]> = []) {
  const bits = new Uint8Array(Math.ceil((w * h) / 8));
  const set = (i: number, j: number, on: boolean) => {
    const n = j * w + i;
    if (on) bits[n >> 3] |= 1 << (n & 7);
    else bits[n >> 3] &= ~(1 << (n & 7));
  };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(i, j, true);
  for (const [i, j] of blocked) set(i, j, false);
  return { layer: { level: "L0", y: 0, origin: [0, 0] as [number, number], w, h }, bits };
}
const c = (i: number): number => (i + 0.5) * CELL;

describe("stage path (BFS over nav.json)", () => {
  it("test_stage_path_straight", () => {
    const g = grid(20, 20);
    const p = findPath(g.layer, g.bits, [c(1), c(1)], [c(18), c(18)])!;
    expect(p.length).toBeGreaterThan(1);
    expect(p[p.length - 1]).toEqual([c(18), c(18)]);
  });
  it("test_stage_path_goes_around_wall", () => {
    const wall: Array<[number, number]> = [];
    for (let j = 0; j < 16; j++) wall.push([10, j]);
    const g = grid(20, 20, wall);
    const p = findPath(g.layer, g.bits, [c(2), c(2)], [c(18), c(2)])!;
    expect(p).not.toBeNull();
    expect(Math.max(...p.map((q) => q[1]))).toBeGreaterThanOrEqual(c(16));
  });
  it("test_stage_path_closed_door_blocks_open_door_passes", () => {
    const wall: Array<[number, number]> = [];
    for (let j = 0; j < 20; j++) wall.push([10, j]);
    const g = grid(20, 20, wall);
    const doorCells = [10 + 5 * 20];
    expect(findPath(g.layer, g.bits, [c(2), c(5)], [c(18), c(5)])).toBeNull();
    expect(findPath(g.layer, g.bits, [c(2), c(5)], [c(18), c(5)], { openCells: { L0: doorCells } })).not.toBeNull();
  });
  it("test_stage_path_obstacle_rect_blocks", () => {
    const g = grid(20, 20);
    const ob = [c(8), c(0), c(12), c(19)]; // a full-height bar across x ~ 8..12
    expect(findPath(g.layer, g.bits, [c(2), c(10)], [c(18), c(10)], { obstacles: [{ level: "L0", rect: ob }] })).toBeNull();
    // an obstacle holding the goal itself (the chair being sat on) is ignored
    expect(findPath(g.layer, g.bits, [c(2), c(10)], [c(10), c(10)], { obstacles: [{ level: "L0", rect: ob }] })).not.toBeNull();
  });
  it("test_stage_path_out_of_layer_returns_null", () => {
    const g = grid(2, 2);
    expect(findPath(g.layer, g.bits, [c(0), c(0)], [100, 100])).toBeNull();
    expect(findPath(g.layer, g.bits, [100, 100], [c(0), c(0)])).toBeNull();
  });
});
