/** Squidward v19 155–159 s: SpongeBob walked from Squidward to the table (2.7 m apart), the base wide stayed locked
 *  where it was cut, only its look panned: both heads off the frame's edges, five seconds of an empty room.
 *  A locked wide that loses a head it can hold again is cut anew. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ROOM: DRoom = { outline: [[-3, -3], [4, -3], [4, 3], [-3, 3]], ceiling: 2.8, open: false };
const sq: DActor = { name: "Squidward", pos: [0, 2.2], yaw: 180, height: 1.8, level: null, room: "R", walking: false, head: [0, 1.7, 2.2] };
const bob = (x: number, z: number, walking: boolean): DActor => ({ name: "SpongeBob", pos: [x, z], yaw: 135, height: 1, level: null, room: "R", walking, walkLeft: walking ? Math.hypot(2.26 - x, z) : 0, head: [x, 0.6, z] });
const inFrame = (o: { cam: V3; look: V3; fov?: number }, h: V3): boolean => {
  const p = ndcOf(h, o.cam, o.look, o.fov ?? 50, 16 / 9);
  return p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
};

describe("a locked wide", () => {
  it("is cut anew when the cast walks out of it", () => {
    const bad: string[] = [];
    for (const r of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const d = createDirector(() => r, { style: "storybook" });
      d.step({ event: { kind: "narrator", durationS: 4, dt: 0, beat: 0, tags: { first: true } }, actors: [sq, bob(-0.2, 1.4, false)], room: ROOM });
      d.step({ event: { kind: "narrator", durationS: 4, dt: 4, beat: 1 }, actors: [sq, bob(-0.2, 1.4, false)], room: ROOM });
      // he walks 2.7 m off to the table at (2.26, 0), on ticks of 0.5 s
      for (let i = 1; i <= 6; i++) {
        const u = i / 6;
        d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, bob(-0.2 + 2.46 * u, 1.4 - 1.4 * u, i < 6)], room: ROOM });
      }
      let o = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, bob(2.26, 0, false)], room: ROOM });
      for (let i = 0; i < 4; i++) o = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, bob(2.26, 0, false)], room: ROOM });
      if (!inFrame(o, sq.head!) || !inFrame(o, [2.26, 0.6, 0])) bad.push(`${r}:${o.plan}`);
    }
    expect(bad).toEqual([]);
  });
});
