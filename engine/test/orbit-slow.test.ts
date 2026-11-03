/** Squidward v28 video 100 s: after a line the base orbit swung its camera 1 m in half a second (0.25 rad/s on a 3 m
 *  radius, snapped along the wall), the next beat cut back near its start: the camera rocked. An orbit drifts, it
 *  does not travel: at most 0.3 m per half second on a pair 2 m apart. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[0, 0], [20, 0], [20, 20], [0, 20]], ceiling: 3, open: false };
const act = (name: string, pos: [number, number], yaw: number): DActor => ({ name, pos, yaw, height: 1.7, level: null, room: "r", walking: false });

describe("the base orbit", () => {
  it("drifts slowly", () => {
    const d = createDirector(() => 0.5);
    const crew = [act("a", [9, 10], 90), act("b", [11, 10], 270)];
    let o = d.step({ event: { kind: "line", speaker: "a", durationS: 10, dt: 0, shot: "orbit" } as DEvent, actors: crew, room: ROOM });
    expect(o.plan).toBe("orbit");
    for (let i = 0; i < 8; i++) {
      const n = d.step({ event: { kind: "tick", dt: 0.5 }, actors: crew, room: ROOM });
      expect(n.plan).toBe("orbit");
      expect(Math.hypot(n.cam[0] - o.cam[0], n.cam[2] - o.cam[2])).toBeLessThanOrEqual(0.3);
      o = n;
    }
  });
});
