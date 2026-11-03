import { describe, it, expect } from "vitest";
import { clampCamera, roomRect } from "../src/runtime/stage/camera.js";

const OUTLINE: Array<[number, number]> = [[0, 5], [0, 0], [6, 0], [6, 5]];

describe("stage camera bounds", () => {
  it("test_stage_room_rect_inset_0_3", () => {
    expect(roomRect(OUTLINE, 0.3)).toEqual({ minx: 0.3, minz: 0.3, maxx: 5.7, maxz: 4.7 });
  });
  it("test_stage_clamp_inside_room_below_ceiling", () => {
    const r = roomRect(OUTLINE, 0.3);
    const p = clampCamera([-4, 9, 20], r, 2.7);
    expect(p[0]).toBeCloseTo(0.3);
    expect(p[2]).toBeCloseTo(4.7);
    expect(p[1]).toBeLessThanOrEqual(2.4 + 1e-9);
  });

});
