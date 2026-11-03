/** Squidward v14 66–85 s: a narration two-shot stood 45° over SpongeBob and Squidward for 19 s (steep 12.8 %).
 *  capTilt could not come down on its own line (the easel and a chair back stood there) and kept the steep frame.
 *  A steep frame first walks round its look point at 30° before it stays steep. */
import { describe, it, expect } from "vitest";
import { capTilt, type DActor, type DirectorOut } from "../src/runtime/stage/director.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const tilt = (o: { cam: V3; look: V3 }): number =>
  (Math.atan2(o.cam[1] - o.look[1], Math.hypot(o.look[0] - o.cam[0], o.look[2] - o.cam[2])) * 180) / Math.PI;

describe("capTilt round the look point", () => {
  it("a steep frame whose own line is blocked low comes down to 30° from another side", () => {
    const bob: DActor = { name: "SpongeBob", pos: [0, 0], yaw: 0, height: 1, level: null, room: "R", walking: false, head: [0, 0.6, 0] };
    const out = { plan: "two", cam: [0, 2.6, 2] as V3, look: [0, 0.8, 0] as V3, cut: 1 } as DirectorOut;
    // a wall of furniture on the +z side, as high as the camera (2.6 m): from there nothing lower sees him
    const clear = (c: V3): boolean => !(c[2] > 0.5 && c[1] < 2.6);
    const room: [number, number][] = [[-4, -4], [4, -4], [4, 4], [-4, 4]];
    const o = capTilt(out, 0, clear, [bob], room);
    expect(tilt(o)).toBeLessThanOrEqual(30.5);
    expect(clear(o.cam)).toBe(true);
  });
});
