/** Squidward, Nov 3 (film 134–136 s): Squidward walked to the door, the follow frame 2.5 m behind him was blocked by a
 *  chair; `unblock` took the first clear point on its rings about the look point (1 m ahead of him), the 0.55 ring,
 *  0.65–0.9 m behind him and over his head: the frame was the top of his head. A blocked frame first looks for a
 *  clear point at least 1.2 m from everybody, then anywhere. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[-6, -6], [6, -6], [6, 6], [-6, 6]], ceiling: 3, open: false };

describe("unblock keeps off the bodies", () => {
  it("a blocked follow frame does not end at the walker's head", () => {
    const walker: DActor = { name: "Squidward", pos: [0, 0], yaw: 0, height: 1.8, level: null, room: "r", walking: true, walkLeft: 4 } as any;
    const other: DActor = { name: "SpongeBob", pos: [3, 3], yaw: 180, height: 1.0, level: null, room: "r", walking: false };
    // the straight frame behind him is blocked (within 30° of his back), except right at his head
    const clear = (cam: [number, number, number]): boolean => {
      const d = Math.hypot(cam[0], cam[2]);
      if (d < 1.0) return true;
      const off = Math.abs((Math.atan2(cam[0], -cam[2]) * 180) / Math.PI);
      return off >= 30;
    };
    let s = 3 >>> 0;
    const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
    const d = createDirector(rng, { style: "storybook" });
    const out = d.step({ event: { kind: "narrator", durationS: 4, dt: 0.5, tags: {} } as any, actors: [walker, other], room: ROOM, rng, clear });
    expect(out.plan).toBe("follow");
    expect(Math.hypot(out.cam[0] - walker.pos[0], out.cam[2] - walker.pos[1])).toBeGreaterThanOrEqual(1.2);
  });
});
