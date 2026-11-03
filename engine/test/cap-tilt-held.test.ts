/** Squidward v34 141.5–144 s (critic): a held wide turned after Squidward walking up to it; every tick his head was
 *  steeper under the camera and capTilt placed the camera anew — down, back, round at 15° steps — a metre between
 *  ticks, y 1.44..2.0. A still frame the director holds stays still: capTilt places it once per cut, a steeper look
 *  later lifts the look point, the camera does not jump. */
import { describe, it, expect } from "vitest";
import { steadyTilt } from "../src/runtime/stage/director.js";

const pitch = (cam: number[], look: number[]): number =>
  (Math.atan2(cam[1] - look[1], Math.hypot(look[0] - cam[0], look[2] - cam[2])) * 180) / Math.PI;

const room = [[-6, -6], [6, -6], [6, 6], [-6, 6]] as [number, number][];

describe("steadyTilt", () => {
  it("a held frame on a walker coming up under it: the camera stays put, the look at most 30° down", () => {
    const tilt = steadyTilt();
    const cam: [number, number, number] = [0, 2.6, 0];
    // a probe that sees only from some spots, so capTilt's choices differ tick to tick
    const clear = (c: number[]) => Math.round(c[0] * 7 + c[2] * 3) % 2 === 0;
    const cams: number[][] = [];
    for (let i = 0; i <= 40; i++) {
      const d = 3 - i * 0.06; // the walker's head comes from 3 m to 0.6 m off
      const look: [number, number, number] = [d, 1.5 - i * 0.01, 0.3];
      const o = tilt({ plan: "wide", cut: 7.008, cam, look, fov: 50 } as any, 0, clear, [], room);
      cams.push(o.cam);
      expect(pitch(o.cam, o.look)).toBeLessThanOrEqual(30.5);
    }
    for (const c of cams) expect(Math.hypot(c[0] - cams[0][0], c[1] - cams[0][1], c[2] - cams[0][2])).toBeLessThan(1e-9);
  });

  it("a new cut, or a camera the director moves, is placed anew", () => {
    const tilt = steadyTilt();
    const a = tilt({ plan: "wide", cut: 1, cam: [0, 2.6, 0], look: [1, 0.5, 0], fov: 50 } as any, 0);
    const b = tilt({ plan: "wide", cut: 2, cam: [3, 2.6, 0], look: [4, 0.5, 0], fov: 50 } as any, 0);
    expect(b.cam[0]).toBeCloseTo(3, 6);
    const c = tilt({ plan: "wide", cut: 2, cam: [3.4, 2.6, 0], look: [4.4, 0.5, 0], fov: 50 } as any, 0);
    expect(c.cam[0]).toBeCloseTo(3.4, 6);
    expect(a.cam[0]).toBeCloseTo(0, 6);
  });
});
