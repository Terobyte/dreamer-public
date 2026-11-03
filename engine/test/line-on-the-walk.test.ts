/** Squidward v18 154–157 s: SpongeBob said "Welcome to my pineapple!" walking to the table; a spoken line never got a
 *  walk move (WALK_ONLY), the frame stood still and he walked out of it, Squidward's back left in the frame.
 *  A line said on the walk is followed. */
import { describe, it, expect } from "vitest";
import { pickMove, STYLES } from "../src/runtime/stage/styles.js";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

describe("a line on the walk", () => {
  it("pickMove follows a speaker who walks", () => {
    for (const r of [0.05, 0.5, 0.95]) expect(pickMove(STYLES.storybook!, {}, () => r, { line: true, walking: true }).id).toBe("follow_side");
  });

  it("the director keeps the walking speaker in frame through the line", () => {
    const ROOM: DRoom = { outline: [[-5, -5], [5, -5], [5, 5], [-5, 5]], ceiling: 3, open: false };
    const sq: DActor = { name: "Squidward", pos: [0, 1], yaw: 180, height: 1.8, level: null, room: "R", walking: false, head: [0, 1.7, 1] };
    const bobAt = (z: number): DActor => ({ name: "SpongeBob", pos: [0.8, z], yaw: 180, height: 1, level: null, room: "R", walking: true, walkLeft: 3 + z, head: [0.8, 0.6, z] });
    for (const r of [0.1, 0.5, 0.9]) {
      const d = createDirector(() => r, { style: "storybook" });
      d.step({ event: { kind: "narrator", durationS: 4, dt: 0, beat: 0, tags: { first: true } }, actors: [sq, bobAt(0)], room: ROOM });
      let o = d.step({ event: { kind: "line", speaker: "SpongeBob", durationS: 5, dt: 4, beat: 1 }, actors: [sq, bobAt(0)], room: ROOM });
      for (let i = 1; i <= 6; i++) {
        const b = bobAt(-0.4 * i);
        o = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, b], room: ROOM });
        const p = ndcOf(b.head!, o.end && o.moveDurationS ? o.cam : o.cam, o.lookRef ? b.head! : o.look, o.fov ?? 50, 16 / 9);
        expect(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.depth > 0.2, `rng ${r} step ${i} move ${o.move}`).toBe(true);
      }
    }
  });
});
