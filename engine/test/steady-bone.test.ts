/** Squidward v31 147.9–149.8 s: follow_side looked at the walking head bone every frame; the walk's bob and sway
 *  (a few cm at two steps a second) rocked the camera two metres off. The look follows the body's root, the head's
 *  offset from it smoothed: no rocking, no lag behind the walker. */
import { describe, it, expect } from "vitest";
import { steadyBone } from "../src/runtime/stage/shotplan.js";

describe("steadyBone", () => {
  it("a head swaying 4 cm and bobbing 4 cm while walking 1 m/s: the look stays on the line, level, not behind", () => {
    const f = steadyBone();
    let worstSide = 0, worstUp = 0, worstLag = 0;
    for (let i = 0; i <= 300; i++) {
      const t = i / 60;
      const root: [number, number, number] = [t, 0, 0];
      const head: [number, number, number] = [t + 0.05, 1.6 + 0.04 * Math.sin(2 * Math.PI * 4 * t), 0.04 * Math.sin(2 * Math.PI * 2 * t)];
      const p = f("Squid", root, head, t);
      if (t < 1) continue;
      worstSide = Math.max(worstSide, Math.abs(p[2]));
      worstUp = Math.max(worstUp, Math.abs(p[1] - 1.6));
      worstLag = Math.max(worstLag, Math.abs(p[0] - (t + 0.05)));
    }
    expect(worstSide).toBeLessThan(0.01);
    expect(worstUp).toBeLessThan(0.01);
    expect(worstLag).toBeLessThan(0.01);
  });

  it("a head that leans and stays there is looked at where it is", () => {
    const f = steadyBone();
    let p: number[] = [];
    for (let i = 0; i <= 120; i++) p = f("Squid", [0, 0, 0], [0.2, 1.5, 0.1], i / 60);
    expect(p[0]).toBeCloseTo(0.2, 2);
    expect(p[1]).toBeCloseTo(1.5, 2);
    expect(p[2]).toBeCloseTo(0.1, 2);
  });
});
