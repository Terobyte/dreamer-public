import { describe, expect, it } from "vitest";
import { pickCamera } from "./cams";

describe("B08 top view with empty meshes", () => {
  it("does not produce NaN camera position / matrix", () => {
    const geo: any = { spawn: { at: [0, 0], y: 0, yaw: 0 }, meshes: [] };
    const { camera } = pickCamera(geo, new URLSearchParams("top=1"), 1.6);
    expect(Number.isFinite(camera.position.x)).toBe(true);
    expect(Number.isFinite(camera.position.z)).toBe(true);
    camera.updateMatrixWorld();
    const els = (camera as any).matrixWorld.elements as number[];
    for (const v of els) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
