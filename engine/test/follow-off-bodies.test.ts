/** Squidward v18 150–156 s: SpongeBob walked to the table, the follow camera stood 2.5 m behind him, right at
 *  Squidward's back (his head 1.25 m from the lens, a dark half of the frame). A follow keeps off other bodies. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[-5, -5], [5, -5], [5, 5], [-5, 5]], ceiling: 3, open: false };

describe("follow", () => {
  it("does not stand at another actor's back", () => {
    // SpongeBob walks +z from the origin; Squidward stands 2.4 m behind him, where the follow camera would go
    const bob: DActor = { name: "SpongeBob", pos: [0, 0], yaw: 0, height: 1, level: null, room: "R", walking: true, walkLeft: 3, head: [0, 0.6, 0] };
    const sq: DActor = { name: "Squidward", pos: [0.3, -2.4], yaw: 0, height: 1.8, level: null, room: "R", walking: false, head: [0.3, 1.7, -2.4] };
    for (const r of [0.1, 0.5, 0.9]) {
      const d = createDirector(() => r, { style: "storybook" });
      d.step({ event: { kind: "narrator", durationS: 4, dt: 0, beat: 0, tags: { first: true } }, actors: [bob, { ...sq }], room: ROOM });
      d.step({ event: { kind: "walk", speaker: "SpongeBob", dt: 0.5, beat: 1, tags: { enter: true } } as any, actors: [bob, sq], room: ROOM });
      let o = d.step({ event: { kind: "line", speaker: "SpongeBob", durationS: 5.6, dt: 0.5, beat: 1 }, actors: [bob, sq], room: ROOM });
      for (let i = 0; i < 3; i++) o = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [bob, sq], room: ROOM });
      expect(Math.hypot(o.cam[0] - sq.pos[0], o.cam[2] - sq.pos[1]), `rng ${r} plan ${o.plan}`).toBeGreaterThanOrEqual(1.2);
    }
  });
});
