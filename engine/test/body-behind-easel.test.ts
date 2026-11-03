/** Squidward v22 62–84 s: the two-shot looked past the easel; Squidward's face cleared its canvas, his chest and arm
 *  were behind it, and the probe (face and eye only) called the frame clear. A pair frame wants the body seen too. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 2.8, open: false };
const sq: DActor = { name: "Squidward", pos: [0.75, 0], yaw: 270, height: 1.8, level: null, room: "R", walking: false, head: [0.75, 1.7, 0], face: [0.65, 1.62, 0] };
const bob: DActor = { name: "SpongeBob", pos: [0, 0], yaw: 90, height: 1, level: null, room: "R", walking: false, head: [0, 0.6, 0], face: [0.1, 0.6, 0] };
// the canvas: a thin panel in front of Squidward on both sides of the pair, from 0.7 m to 1.45 m (under his face)
const boxes = [
  { min: [0.4, 0.7, 0.35] as V3, max: [1.2, 1.45, 0.45] as V3 },
  { min: [0.4, 0.7, -0.45] as V3, max: [1.2, 1.45, -0.35] as V3 },
];
const hit = (a: V3, b: V3, bx: { min: V3; max: V3 }): boolean => {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) < 1e-12) { if (a[i] < bx.min[i] || a[i] > bx.max[i]) return false; continue; }
    let u0 = (bx.min[i] - a[i]) / d, u1 = (bx.max[i] - a[i]) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  return true;
};
const clear = (cam: V3, q: V3): boolean => !boxes.some((b) => hit(cam, q, b));
const chest: V3 = [0.75, 1.1, 0];

describe("a pair frame past an easel", () => {
  it("sees the chest, not only the face", () => {
    const bad: string[] = [];
    for (const r of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const d = createDirector(() => r, { style: "storybook" });
      d.step({ event: { kind: "narrator", durationS: 4, dt: 0, beat: 0, tags: { first: true } }, actors: [sq, bob], room: ROOM, clear });
      const o = d.step({ event: { kind: "narrator", durationS: 5, dt: 4, beat: 1 }, actors: [sq, bob], room: ROOM, clear });
      if (!o.end && !clear(o.cam, chest)) bad.push(`${r}:${o.plan}:${o.move}:${(o.warnings ?? []).join("|")}:${o.cam.map((v) => v.toFixed(2))}`);
    }
    expect(bad).toEqual([]);
  });
});
