/** Squidward v22 video 109.5–111 s (director 111–113 s): after a line the base orbit re-solved every tick, capTilt and
 *  cleanEdges moved its camera 1.4 m one way and 0.3 m back, the picture shook for two seconds. Inside one cut a still
 *  frame's camera eases toward the new point; a cut jumps, a move (`end`) is the runtime's. */
import { describe, it, expect } from "vitest";
import { steadyCam } from "../src/runtime/stage/director.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const o = (cut: number, cam: V3, look: V3 = [0, 1, 0], end?: V3) => ({ plan: "orbit", cut, cam, look, ...(end ? { end } : {}) });

describe("steadyCam", () => {
  it("a cut jumps", () => {
    expect(steadyCam(o(1, [0, 1, 0]), o(2, [5, 1, 0]), 0.5).cam).toEqual([5, 1, 0]);
  });
  it("inside a cut the camera eases, a back-and-forth comes out small", () => {
    const a = steadyCam(o(1, [0, 1, 0]), o(1, [1.4, 1, 0]), 0.5);
    expect(a.cam[0]).toBeGreaterThan(0.2);
    expect(a.cam[0]).toBeLessThan(0.9);
    const b = steadyCam(a, o(1, [1.1, 1, 0]), 0.5);
    // it does not turn back: the target is still ahead of where the camera got to
    expect(b.cam[0]).toBeGreaterThanOrEqual(a.cam[0]);
  });
  it("the look eases as the camera does", () => {
    const a = steadyCam(o(1, [0, 1, 0], [0, 1, 5]), o(1, [0, 1, 0], [2, 1, 5]), 0.5);
    expect(a.look[0]).toBeGreaterThan(0.2);
    expect(a.look[0]).toBeLessThan(1.6);
  });
  it("a move is left to the runtime", () => {
    const m = o(1, [1, 1, 0], [0, 1, 0], [2, 1, 0]);
    expect(steadyCam(o(1, [0, 1, 0]), m, 0.5)).toBe(m);
  });
  it("a long way (a walker's pan or a reframe after a room change) is not dragged out: over 2 m it jumps", () => {
    expect(steadyCam(o(1, [0, 1, 0]), o(1, [3, 1, 0]), 0.5).cam).toEqual([3, 1, 0]);
  });
});
