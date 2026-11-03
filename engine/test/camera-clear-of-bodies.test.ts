/** Koshakan meadow, Nov 3 (critic.jsonl): push_in / pull_out / close ended 0.1–0.4 m from an actor, the frame full of
 *  hair. Mirai sat in Mama's lap 0.12 m away: Mirai's close-up stood inside Mama. Every frame the camera now steps back
 *  along its look line until it is out of every body. */
import { describe, it, expect } from "vitest";
import { clearOfBodies, type CamBody } from "../src/runtime/stage/camera.js";

const mama: CamBody = { pos: [0, 0], y0: 0, top: 1.0, r: 0.25 };
const outside = (p: [number, number, number], b: CamBody, min: number): boolean =>
  Math.hypot(p[0] - b.pos[0], p[2] - b.pos[1]) >= b.r + min - 1e-6 || p[1] > b.top + min || p[1] < b.y0 - min;

describe("the camera stays out of the bodies", () => {
  it("a camera clear of everyone stays put", () => {
    expect(clearOfBodies([3, 1, 0], [0, 0.8, 0], [mama], 0.35)).toEqual([3, 1, 0]);
  });
  it("a camera in a body steps back along the look line", () => {
    const p = clearOfBodies([0.3, 0.9, 0], [-1, 0.8, 0], [mama], 0.35);
    expect(outside(p, mama, 0.35)).toBe(true);
    expect(p[0]).toBeGreaterThan(0.3);
    expect(p[2]).toBeCloseTo(0, 6);
  });
  it("a close-up of the child in the lap does not stand inside the mother", () => {
    const mirai: CamBody = { pos: [0.12, 0], y0: 0.3, top: 0.8, r: 0.18 };
    const p = clearOfBodies([0.5, 0.7, 0.1], [0.12, 0.6, 0], [mama, mirai], 0.35);
    expect(outside(p, mama, 0.35)).toBe(true);
    expect(outside(p, mirai, 0.35)).toBe(true);
  });
  it("never steps back more than the cap", () => {
    const p = clearOfBodies([0, 0.5, 0], [0, 0.5, -1], [{ pos: [0, 0], y0: 0, top: 9, r: 50 }], 0.35, 3);
    expect(Math.hypot(p[0], p[2])).toBeLessThanOrEqual(3 + 1e-6);
  });
});
