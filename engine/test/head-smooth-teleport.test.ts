/** Squidward v15 145.8 s: through the pineapple's door (a teleport of ~585 m) the director's smoothed head slid across
 *  the gap, Squidward's head "at" x 401 m for seconds, and the camera was placed for heads that were not there.
 *  A head that jumps farther than a step snaps; a small move is still smoothed. */
import { describe, it, expect } from "vitest";
import { smoothHeadStep } from "../src/runtime/stage/index.js";

describe("smoothHeadStep", () => {
  it("a door teleport snaps the head to where it is", () => {
    const s = smoothHeadStep({ p: [3.6, 1.17, -6], yaw: 90, t: 0 }, { pos: [590, 1.17, 4.5], faceYaw: 200 }, 0.5);
    expect(s.p).toEqual([590, 1.17, 4.5]);
    expect(s.yaw).toBe(200);
  });
  it("a small move is still smoothed", () => {
    const s = smoothHeadStep({ p: [0, 1, 0], yaw: 0, t: 0 }, { pos: [0.2, 1, 0], faceYaw: 0 }, 0.05);
    expect(s.p[0]).toBeGreaterThan(0);
    expect(s.p[0]).toBeLessThan(0.2);
  });
});
