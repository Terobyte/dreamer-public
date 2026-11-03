import { describe, expect, it } from "vitest";
import { CURRENT_CAMERA_STYLE, cameraStyleOf } from "../src/runtime/stage/camera-default.js";
import { STYLES } from "../src/runtime/stage/styles.js";

describe("camera default: the current camera is K1 moves + K2 style", () => {
  it("no ?camera_style= takes the current style, not the legacy frames", () => {
    expect(cameraStyleOf(null)).toBe(CURRENT_CAMERA_STYLE);
    expect(cameraStyleOf("")).toBe(CURRENT_CAMERA_STYLE);
    expect(Object.hasOwn(STYLES, CURRENT_CAMERA_STYLE)).toBe(true);
  });
  it("a named style passes through", () => {
    expect(cameraStyleOf("spielberg")).toBe("spielberg");
  });
  it("legacy frames only on the explicit ?camera_style=legacy", () => {
    expect(cameraStyleOf("legacy")).toBeUndefined();
  });
});
