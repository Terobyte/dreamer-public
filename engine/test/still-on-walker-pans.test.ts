/** Squidward v24 134–136 s and 141–145 s: follow_side came out still (MOVE_STATIC; no room for its path) and the two
 *  walked out of it to the door. Any still frame on a walking speaker turns its look after him, not only the
 *  director's own fallback (cf531cc). */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const ROOM: DRoom = { outline: [[-5, -5], [5, -5], [5, 5], [-5, 5]], ceiling: 3, open: false };
const sq: DActor = { name: "Squidward", pos: [-2, 3], yaw: 180, height: 1.8, level: null, room: "R", walking: false, head: [-2, 1.7, 3] };
const bob = (x: number, walking: boolean): DActor => ({ name: "SpongeBob", pos: [x, 0], yaw: 90, height: 1, level: null, room: "R", walking, walkLeft: walking ? 3 - x : 0, head: [x, 0.6, 0] });

describe("a still frame forced on a walking speaker", () => {
  it("follows him with its look", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    d.step({ event: { kind: "narrator", durationS: 4, dt: 0, beat: 0, tags: { first: true } }, actors: [sq, bob(-3, false)], room: ROOM });
    let o = d.step({ event: { kind: "line", speaker: "SpongeBob", durationS: 6, dt: 4, beat: 1, forced: { move: "medium", subject: { actor: "SpongeBob" } } } as any, actors: [sq, bob(-3, true)], room: ROOM });
    const bad: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const b = bob(-3 + 0.6 * i, i < 10);
      o = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, b], room: ROOM });
      const p = ndcOf(b.head!, o.cam, o.look, o.fov ?? 50, 16 / 9);
      if (!o.end && !(p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1)) bad.push(`${i}:${o.move}:${p.x.toFixed(2)}`);
    }
    expect(bad).toEqual([]);
  });
});
