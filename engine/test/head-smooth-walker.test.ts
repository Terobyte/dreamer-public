/** Koshakan k1 23.9 s: Mama walked up to Mirai's bed; the director's head point, low-passed over ~1 s so a nod does not
 *  bob the camera, trailed her by 0.6 m (head -2.27 vs body -1.66). The close shot was planned 1.2 m from that trailing
 *  head and stood 0.67 m from the real one: the back of her hair filled the frame. The smoothing is for the head's
 *  motion on the body, not for the body walking: a walker's head stays where the walker is. */
import { describe, it, expect } from "vitest";
import { smoothHeadStep } from "../src/runtime/stage/index.js";

describe("smoothHeadStep on a walker", () => {
  it("the smoothed head keeps up with a body walking at 0.6 m/s", () => {
    let prev: { p: [number, number, number]; yaw: number; t: number; b?: [number, number] } | undefined;
    const dt = 1 / 60;
    let x = -3;
    for (let i = 0; i < 180; i++) {
      x += 0.6 * dt;
      const s = smoothHeadStep(prev, { pos: [x, 1.35, 2.3], faceYaw: 90 }, prev ? dt : 0, [x, 2.3]);
      prev = { ...s, t: i * dt };
    }
    expect(Math.abs(prev!.p[0] - x)).toBeLessThan(0.05);
  });
  it("a nod on a standing body is still smoothed", () => {
    const s = smoothHeadStep({ p: [0, 1.5, 0], yaw: 0, t: 0, b: [0, 0] }, { pos: [0.2, 1.3, 0], faceYaw: 0 }, 0.05, [0, 0]);
    expect(s.p[0]).toBeGreaterThan(0);
    expect(s.p[0]).toBeLessThan(0.2);
    expect(s.p[1]).toBeGreaterThan(1.3);
  });
});
