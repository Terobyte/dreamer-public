/** Squidward, Nov 3 (bisect renders, 19–24 s): SpongeBob came in at the door, the director took a crane_down on him;
 *  he walked on to his place behind the chair backs and the move held him hidden to its end, 4.5 s. A held frame that
 *  loses a head was cut again only when it stood still; a move is judged where its camera is by now (start to end
 *  over its duration) and is cut again the same way. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

type V3 = [number, number, number];
const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const sq: DActor = { name: "Squidward", pos: [0.7, 2.0], yaw: 240, height: 1.8, head: [0.7, 1.15, 2.0], level: null, room: "r", walking: false };
const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
};
/** distance from p to the segment a–b */
const toSeg = (p: V3, a: V3, b: V3): number => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
};

describe("a move that loses a head is cut again", () => {
  it("SpongeBob's face goes behind the chairs for the whole path of the move: a new cut within a second", () => {
    let tried = 0, recut = 0;
    for (let seed = 1; seed <= 40 && tried < 6; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng, { style: "storybook" });
      const sb: any = { name: "SpongeBob", pos: [-2.25, 0.1], yaw: 60, height: 1.0, head: [-2.25, 0.57, 0.1], face: [-2.25, 0.75, 0.1], level: null, room: "r", walking: false };
      let path: [V3, V3] | null = null;
      const clear = (c: V3, l: V3): boolean =>
        !(path && Math.hypot(l[0] - sb.face[0], l[1] - sb.face[1], l[2] - sb.face[2]) < 0.02 && toSeg(c, path[0], path[1]) < 0.3);
      d.step({ event: { kind: "narrator", durationS: 4, dt: 0.5, tags: {} } as any, actors: [sq, sb], room: ROOM, rng, clear });
      // he comes in at the door: the director's entry move (storybook: crane_down on him)
      let out = d.step({ event: { kind: "walk", speaker: "SpongeBob", dt: 0.5, durationS: 6, tags: { enter: true } } as any, actors: [sq, sb], room: ROOM, rng, clear });
      if (!out.end) continue;
      const p = ndcOf(sb.head, out.cam, out.look, out.fov ?? 50, 16 / 9);
      if (!(p.depth > 0.2 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1)) continue;
      tried++;
      path = [[...out.cam] as V3, [...out.end] as V3];
      const cut0 = out.cut;
      for (let k = 0; k < 3; k++) out = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, sb], room: ROOM, rng, clear });
      if (out.cut !== cut0) recut++;
    }
    expect(tried).toBeGreaterThan(0);
    expect(recut).toBe(tried);
  }, 120_000);
});

describe("the accent styles' base frame is held to the same rule", () => {
  // v22 21–24.6 s: on storybook's plain beats the base planner's two-shot (unblock found no clear point) framed
  // SpongeBob behind the chair backs 3.5 s; the recut lived only in the move branch
  it("a narrator beat whose base frame hides a head in it does not hold it past a second", () => {
    const sb: DActor = { name: "SpongeBob", pos: [-2.25, 0.1], yaw: 60, height: 1.0, head: [-2.25, 0.57, 0.1], face: [-2.25, 0.75, 0.1], level: null, room: "r", walking: false };
    /** the chairs and the table: SpongeBob's face is seen only from the far corner (x > 2.4, z < -2.4), out of unblock's ring */
    const clear = (c: V3, l: V3): boolean => !(Math.hypot(l[0] - sb.face![0], l[1] - sb.face![1], l[2] - sb.face![2]) < 0.02 && !(c[0] > 2.4 && c[2] < -2.4));
    const bad: string[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng, { style: "storybook" });
      let held = 0;
      for (const ev of [{ kind: "narrator", durationS: 6, dt: 0.5, tags: { first: true } }, { kind: "narrator", durationS: 6, dt: 0.5, tags: {} }, { kind: "walk", speaker: "SpongeBob", dt: 0.5, tags: {} }, { kind: "narrator", durationS: 6, dt: 0.5, tags: {} }]) {
        for (let k = 0; k < 8; k++) {
          const out = d.step({ event: (k ? { kind: "tick", dt: 0.5 } : ev) as any, actors: [sq, sb], room: ROOM, rng, clear });
          const p = ndcOf(sb.head!, out.cam, out.look, out.fov ?? 50, 16 / 9);
          const hid = p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && !clear(out.cam as V3, sb.face as V3);
          held = hid ? held + 0.5 : 0;
          if (held > 1 && bad.length < 6) bad.push(`seed ${seed} ${out.plan}/${out.move} cam ${out.cam.map((v) => v.toFixed(2))}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);
});
