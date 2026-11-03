/** Squidward v12 64–71 s: "SpongeBob waved his arms toward the window." came 3.7 s after Squidward's line; the
 *  storybook camera swallowed the cut (sooner than asl.min after the move began) and kept the close on Squidward,
 *  so the wave played off screen. A narration about an actor shows that actor. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ROOM: DRoom = { outline: [[-5, -5], [5, -5], [5, 5], [-5, 5]], ceiling: 3, open: false };
const squid: DActor = { name: "Squidward", pos: [0, 0], yaw: 180, height: 1.8, level: null, room: "R", walking: false, head: [0, 1.7, 0] };
const sb: DActor = { name: "SpongeBob", pos: [1.6, -1.4], yaw: 300, height: 1.0, level: null, room: "R", walking: false, head: [1.6, 0.9, -1.4] };
const inFrame = (o: { cam: V3; look: V3; fov?: number }, h: V3): boolean => {
  const p = ndcOf(h, o.cam, o.look, o.fov ?? 50, 16 / 9);
  return p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
};

describe("narration about an actor", () => {
  it("is not left on the previous speaker's close (v12 64–71 s: SpongeBob's wave off screen)", () => {
    const missed: number[] = [];
    for (const r of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const d = createDirector(() => r, { style: "storybook" });
      const A = [squid, sb];
      d.step({ event: { kind: "narrator", durationS: 6, dt: 0, beat: 0, tags: { first: true } }, actors: A, room: ROOM });
      d.step({ event: { kind: "line", speaker: "Squidward", durationS: 2.3, dt: 6, beat: 1 }, actors: A, room: ROOM });
      let o = d.step({ event: { kind: "narrator", durationS: 4, dt: 3, beat: 2, about: "SpongeBob" }, actors: A, room: ROOM });
      for (let i = 0; i < 6; i++) o = d.step({ event: { kind: "tick", dt: 0.5 }, actors: A, room: ROOM });
      if (!inFrame(o, sb.head!)) missed.push(r);
    }
    expect(missed).toEqual([]);
  });
});
