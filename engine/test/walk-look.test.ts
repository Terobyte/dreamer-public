import { describe, it, expect } from "vitest";
import { lookDir } from "../src/runtime/cams.js";
import { mouseLook } from "../src/runtime/walk.js";

describe("walk mouse look", () => {
  it("test_mouse_y_pitches_and_clamps", () => {
    // moving the mouse up (negative movementY) looks up, same 0.2 deg/px as yaw
    expect(mouseLook(0, 0, 10, -50)).toEqual([-2, 10]);
    expect(mouseLook(0, 0, 0, 50)).toEqual([0, -10]);
    expect(mouseLook(0, 80, 0, -1000)[1]).toBe(85);
    expect(mouseLook(0, -80, 0, 1000)[1]).toBe(-85);
  });

  it("test_look_dir_tilts_with_pitch", () => {
    const flat = lookDir(90, 0);
    expect(flat.x).toBeCloseTo(1);
    expect(flat.y).toBeCloseTo(0);
    const up = lookDir(0, 45);
    expect(up.y).toBeCloseTo(Math.SQRT1_2);
    expect(up.z).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1);
  });
});
