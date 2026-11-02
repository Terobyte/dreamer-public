/**
 * Koshakan bedroom (Nov 2): the close on seated Mama looked at a standing head (height × 0.9) from a standing eye —
 * her head sat at −0.58 of the frame and her body filled 123 % of it. The director takes the measured head point.
 */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[0, 0], [8, 0], [8, 8], [0, 8]], ceiling: 3, open: false };
const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 0, height: 1.7, level: null, room: "r", walking: false, ...o });

function close(actors: DActor[]) {
  const d = createDirector(() => 0.5);
  const room = ROOM;
  d.step({ event: { kind: "line", speaker: "Mama", durationS: 2, dt: 0 }, actors, room });
  return d.step({ event: { kind: "line", speaker: "Mama", durationS: 2, dt: 0, shot: "close" }, actors, room });
}

describe("director frames the head where it is", () => {
  it("a seated speaker: the close looks at her head and the camera stands at her eye level", () => {
    const out = close([act("Mama", [4, 4], { head: [4, 1.05, 4.1] }), act("Mirai", [4, 6], { yaw: 180 })]);
    expect(out.plan).toBe("close");
    expect(out.look[1]).toBeCloseTo(1.05, 5);
    expect(out.look[2]).toBeCloseTo(4.1, 5);
    expect(out.cam[1]).toBeGreaterThan(0.8);
    expect(out.cam[1]).toBeLessThan(1.2);
  });

  it("no measured head: the standing guess as before", () => {
    const out = close([act("Mama", [4, 4]), act("Mirai", [4, 6], { yaw: 180 })]);
    expect(out.look[1]).toBeCloseTo(1.7 * 0.9, 5);
  });
});
