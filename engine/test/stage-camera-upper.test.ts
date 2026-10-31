import { describe, it, expect } from "vitest";
import { directShot, roomRect } from "../src/runtime/stage/camera.js";

// F10: shots on an upper floor must stay above its floor, not at absolute 1.0-1.5 m.
const OUTLINE: Array<[number, number]> = [[0, 5], [0, 0], [6, 0], [6, 5]];
const FLOOR_Y = 3.0;
const CEIL = 5.7;

describe("stage camera on the upper floor (F10)", () => {
  it("test_stage_shots_above_upper_floor", () => {
    const r = roomRect(OUTLINE, 0.3);
    const actors = [
      { pos: [3.0, 2.5] as [number, number], speaking: true },
      { pos: [4.0, 3.0] as [number, number], speaking: false },
    ];
    for (const kind of ["wide", "two", "close"] as const) {
      const s = (directShot as any)(kind, actors, r, CEIL, FLOOR_Y);
      expect(s.pos[1]).toBeGreaterThanOrEqual(FLOOR_Y);
      expect(s.pos[1]).toBeLessThanOrEqual(CEIL - 0.3 + 1e-9);
      expect(s.look[1]).toBeGreaterThanOrEqual(FLOOR_Y);
      expect(s.pos[0]).toBeGreaterThanOrEqual(r.minx - 1e-9);
      expect(s.pos[0]).toBeLessThanOrEqual(r.maxx + 1e-9);
      expect(s.pos[2]).toBeGreaterThanOrEqual(r.minz - 1e-9);
      expect(s.pos[2]).toBeLessThanOrEqual(r.maxz + 1e-9);
    }
  });
});
