/** Squidward v45 150.6–155.6 s: SpongeBob, in the pineapple, says "Welcome to my pineapple" to Squidward at the door
 *  3.9 m off; the frame stood before SpongeBob's face, 1.6 m up, and Squidward was out of it five seconds. An
 *  over-the-shoulder took the point nearest the speaker's face and never asked if the shoulder was in the frame;
 *  SpongeBob faced away from him. A shot over the listener's shoulder holds the listener. Room and actors from the
 *  v45 critic's cut row. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DirectorInput, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const PINE: DRoom = {
  outline: [[586.4, 0], [592.4, 0], [592.4, 5.5], [586.4, 5.5], [586.288, 5.278], [586.185, 5.051], [586.092, 4.82], [586.008, 4.586], [585.935, 4.348], [585.872, 4.107], [585.82, 3.864], [585.777, 3.618], [585.746, 3.371], [585.724, 3.123], [585.714, 2.874], [585.714, 2.626], [585.724, 2.377], [585.746, 2.129], [585.777, 1.882], [585.82, 1.636], [585.872, 1.393], [585.935, 1.152], [586.008, 0.914], [586.092, 0.68], [586.185, 0.449], [586.288, 0.222]],
  ceiling: 2.7, open: false, floorY: 0,
};
const bob: DActor = { head: [591.792, 0.588, 1.956], face: [591.792, 0.754, 1.956], faceYaw: 162.57, name: "SpongeBob", pos: [591.82, 1.94], yaw: 159.012, height: 1, level: "L0", room: "living", walking: false } as DActor;
const sq: DActor = { head: [588.408, 1.16, 3.918], face: [588.408, 1.408, 3.918], faceYaw: 130.715, name: "Squidward", pos: [588.4, 3.9], yaw: 180, height: 1.8, level: "L0", room: "living", walking: false } as DActor;

const inp = (ev: DirectorInput["event"]): DirectorInput => ({ event: ev, actors: [bob, sq], room: PINE, fov: 50, aspect: 16 / 9 });
const inFrame = (p: V3, o: { cam: V3; look: V3; fov?: number }): boolean => {
  const n = ndcOf(p, o.cam, o.look, o.fov ?? 50, 16 / 9);
  return n.depth > 0.2 && Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1;
};

describe("an over-the-shoulder holds the listener", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: SpongeBob's ots line keeps Squidward in the frame`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step(inp({ kind: "tick", dt: 0.017, room: "living" }));
      const o = d.step(inp({ kind: "line", speaker: "SpongeBob", durationS: 3, dt: 0.017, room: "living", shot: "ots" }));
      expect(inFrame(bob.head!, o), `bob, cam ${o.cam} plan ${o.plan}`).toBe(true);
      expect(inFrame(sq.face!, o), `squidward, cam ${o.cam} plan ${o.plan}`).toBe(true);
    });
  }
});
