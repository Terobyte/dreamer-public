import { describe, it, expect } from "vitest";
import { clipFaceYaw } from "../src/runtime/stage/clipfacts.js";

// L173: clipfacts face_yaw was measured per clip and never read
describe("clipFaceYaw", () => {
  it("adds the clip's face turn to the body yaw, wrapped to 0..360", () => {
    expect(clipFaceYaw(90, { face_yaw: 45 })).toBe(135);
    expect(clipFaceYaw(350, { face_yaw: 30 })).toBe(20);
    expect(clipFaceYaw(10, { face_yaw: 340 })).toBe(350);
  });
  it("is undefined without a yaw (face up or down) or without facts", () => {
    expect(clipFaceYaw(90, { face_yaw: null })).toBeUndefined();
    expect(clipFaceYaw(90, {})).toBeUndefined();
    expect(clipFaceYaw(90, undefined)).toBeUndefined();
    expect(clipFaceYaw(90, { face_yaw: Number.NaN })).toBeUndefined();
  });
});
