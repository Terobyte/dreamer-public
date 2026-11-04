/** Squidward v39 149.6–152.6 s: Squidward came into the pineapple facing south (yaw 180) while his route went
 *  south-west; the director guessed the walk from yaw x walkLeft, stood follow_side "beside" that guess — on his real
 *  path — and he walked up to 0.7 m off the lens. A walk shot is planned on where the walker really goes. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[-6, -6], [6, -6], [6, 6], [-6, 6]], ceiling: 3, open: false };
const segDist = (p: [number, number], a: [number, number], b: [number, number]): number => {
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
};

describe("a walk shot plans on the walker's real goal", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`follow keeps off the real path when the walker still faces elsewhere (rng ${seed})`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      const still: DActor = { name: "a", pos: [3, 3], yaw: 0, height: 1.7, level: null, room: "R", walking: false };
      const from: [number, number] = [0, 2];
      const to: [number, number] = [3, -1];
      const w: DActor = { name: "b", pos: from, yaw: 180, height: 1.7, level: null, room: "R", walking: true, walkLeft: Math.hypot(3, 3), walkTo: to };
      const o = d.step({ event: { kind: "walk", speaker: "b", dt: 0.1, room: "R", tags: { enter: true } }, actors: [still, w], room: ROOM });
      if (!o.end) return; // a still frame is placed by offWalkPaths (still-off-every-path.test.ts)
      for (const c of [o.cam, o.end]) expect(segDist([c[0], c[2]], from, to)).toBeGreaterThanOrEqual(1.2);
    });
  }
});
