import { describe, it, expect } from "vitest";
import { pickCamera } from "../src/runtime/cams.js";

function geoWithMeshes(meshes: { kind: string; positions: number[] }[]): any {
  return {
    spawn: { at: [0, 0], y: 0, yaw: 0 },
    floors: [{ room: "r", level: "l", y: 0, outline: [[-1, -1], [1, -1], [1, 1], [-1, 1]] }],
    meshes,
    cameras: [],
  };
}

describe("pickCamera", () => {
  it("test_cam_default_fov", () => {
    const geo = geoWithMeshes([]);
    geo.cameras = [{ id: "a", pos: [0, 1, 0], look: [0, 1, -1] }];
    const setup = pickCamera(geo, new URLSearchParams("cam=a"), 1);
    expect((setup.camera as any).fov).toBeCloseTo(60, 6);
  });

  it("test_top_view_bounds_include_wall_extents", () => {
    // the floor outline spans [-1, 1], but a wall/cap mesh sticks out past
    // it (thickness straddles the room boundary) to [-1.2, 1.2]: the top
    // view must frame the wall, not just the floor
    const geo = geoWithMeshes([
      {
        kind: "cap",
        positions: [-1.2, 2.5, -1.2, 1.2, 2.5, -1.2, 1.2, 2.5, 1.2, -1.2, 2.5, 1.2],
      },
    ]);
    const setup = pickCamera(geo, new URLSearchParams("top=1"), 1);
    const cam = setup.camera as any;
    expect(cam.right).toBeGreaterThanOrEqual(1.2);
    expect(cam.left).toBeLessThanOrEqual(-1.2);
    expect(cam.top).toBeGreaterThanOrEqual(1.2);
    expect(cam.bottom).toBeLessThanOrEqual(-1.2);
  });
});
