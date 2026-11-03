/** Squidward, Nov 3 (v18 20–22 s, 39–41 s): a two-shot held SpongeBob behind a tall chair back for six seconds; the
 *  director asked the sight probe about its look point (the middle between the heads), never about his head. Every
 *  head the director keeps in its frame is one the probe sees. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const sb: DActor = { name: "SpongeBob", pos: [-2.25, 0.1], yaw: 60, height: 1.0, head: [-2.25, 0.59, 0.1], level: null, room: "r", walking: false };
const sq: DActor = { name: "Squidward", pos: [0.7, 2.0], yaw: 240, height: 1.8, head: [0.7, 1.15, 2.0], level: null, room: "r", walking: false };
// a chair back hides SpongeBob's head from the whole +z side of him (z > 0.8), any height under 1.6 m
const clear = (c: [number, number, number], l: [number, number, number]): boolean => {
  if (Math.hypot(l[0] - sb.head![0], l[1] - sb.head![1], l[2] - sb.head![2]) < 0.05) return !(c[2] > 0.8 && c[1] < 1.6);
  return true;
};
const evs: DEvent[] = [
  { kind: "narrator", durationS: 4, dt: 0.5, tags: {} } as any,
  { kind: "line", speaker: "Squidward", durationS: 3, dt: 0.5, tags: { look: true } },
  { kind: "line", speaker: "SpongeBob", durationS: 3, dt: 0.5, tags: { look: true } },
  { kind: "narrator", durationS: 4, dt: 0.5, tags: {} } as any,
];

describe("the director's frames see the heads they hold", () => {
  it("SpongeBob behind the chair back: never kept in frame unseen", () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      let s = seed >>> 0;
      const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
      const d = createDirector(rng, { style: "storybook" });
      for (const ev of evs)
        for (let k = 0; k < 6; k++) {
          const out = d.step({ event: k ? { kind: "tick", dt: 0.5 } : ev, actors: [sq, sb], room: ROOM, rng, clear });
          const frames: Array<[any, any, number]> = [[out.cam, out.look, out.fov ?? 50]];
          if (out.end) frames.push([out.end, out.lookEnd ?? out.look, out.fovEnd ?? out.fov ?? 50]);
          for (const [c, l, f] of frames) {
            const p = ndcOf(sb.head!, c, l, f, 16 / 9);
            const inFrame = p.depth > 0.2 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1;
            if (inFrame && !clear(c, sb.head!) && bad.length < 6) bad.push(`seed ${seed} ${ev.kind}/${k} ${out.plan} ${out.move ?? ""} cam ${c.map((x: number) => x.toFixed(2))}`);
          }
        }
    }
    expect(bad).toEqual([]);
  });
});
