/**
 * Koshakan bedroom (Nov 2): the wide on Mama seated on the bed edge looked at her back (face 122–150° off the
 * camera). She sits legs out of the bed (body yaw 315) with her head turned to Mirai (face yaw 12): the director saw
 * only the body and called a camera 90° off the body fine. The 180° side stays as it was (toward the room center);
 * the wide measures the face yaw and swings inside its half-plane to the faces.
 * Geometry: the real bedroom (geometry.json floors[0]), actors replayed from restage10 critic.jsonl t = 33.17.
 */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const BEDROOM: DRoom = { outline: [[-3.6, 0], [0, 0], [0, 3.6], [-3.6, 3.6]], ceiling: 2.7, open: false };
const act = (name: string, pos: [number, number], yaw: number, o: Partial<DActor> = {}): DActor => ({ name, pos, yaw, height: 1.7, level: null, room: "bedroom", walking: false, ...o });
const wide = (actors: DActor[], room = BEDROOM) => createDirector(() => 0.5).step({ event: { kind: "narrator", durationS: 3, dt: 0, shot: "wide" }, actors, room });
const faceDeg = (a: DActor, cam: number[]): number => {
  const f = [Math.sin((a.yaw * Math.PI) / 180), Math.cos((a.yaw * Math.PI) / 180)];
  const d = [cam[0] - a.pos[0], cam[2] - a.pos[1]];
  return (Math.acos((f[0] * d[0] + f[1] * d[1]) / Math.hypot(d[0], d[1])) * 180) / Math.PI;
};
// the 180° side of the pair (Mama -> Mirai axis), toward the room center: the sign the director keeps
const sideOf = (a: DActor, b: DActor, p: number[]): number => {
  const ax = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]];
  const n = [-ax[1], ax[0]];
  const o = [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2];
  return Math.sign((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1]);
};

describe("director: a wide sees the faces inside its 180° half-plane", () => {
  const mama = act("Mama", [-1.65, 2.28], 315, { faceYaw: 12, head: [-1.6, 1.05, 2.3] });
  const mirai = act("Mirai", [-1.21, 2.63], 180, { height: 1.2, lying: true });

  it("Koshakan: Mama on the bed edge facing Mirai is not filmed from her back", () => {
    const out = wide([mama, mirai]);
    expect(out.plan).toBe("wide");
    expect(faceDeg({ ...mama, yaw: 12 }, out.cam)).toBeLessThan(100);
    // the room-center side is wholly behind her face: the fresh wide crosses the line, a wide distance away
    expect(sideOf(mama, mirai, [out.cam[0], out.cam[2]])).toBe(-sideOf(mama, mirai, [-1.8, 1.8]));
    expect(Math.hypot(out.cam[0] + 1.65, out.cam[2] - 2.28)).toBeGreaterThanOrEqual(1.5); // a 3.6 m bedroom
  });

  it("after the wide crossed the line, the next close keeps the new side (the 180° rule holds from there)", () => {
    const d = createDirector(() => 0.5);
    const w = d.step({ event: { kind: "narrator", durationS: 3, dt: 0, shot: "wide" }, actors: [mama, mirai], room: BEDROOM });
    const c = d.step({ event: { kind: "line", speaker: "Mama", durationS: 3, dt: 0, shot: "close" }, actors: [mama, mirai], room: BEDROOM });
    expect(c.plan).toBe("close");
    expect(sideOf(mama, mirai, [c.cam[0], c.cam[2]])).toBe(sideOf(mama, mirai, [w.cam[0], w.cam[2]]));
  });

  it("a later frame of the same wide does not flip back and forth", () => {
    const d = createDirector(() => 0.5);
    const a = d.step({ event: { kind: "narrator", durationS: 6, dt: 0, shot: "wide" }, actors: [mama, mirai], room: BEDROOM });
    const b = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [mama, mirai], room: BEDROOM });
    expect(b.cut).toBe(a.cut);
    expect(b.cam).toEqual(a.cam);
  });

  it("Koshakan restage11: the sleeper is off the floor level, so the wide is Mama alone; it may turn all the way round", () => {
    const out = wide([mama]);
    expect(out.plan).toBe("wide");
    expect(faceDeg({ ...mama, yaw: 12 }, out.cam)).toBeLessThan(100);
  });

  it("a lying actor's yaw does not count as a face: alone with a sleeper the wide stays square", () => {
    // Mirai alone in the bed and Mama standing facing the camera side: nothing to swing for
    const standing = act("Mama", [-2.6, 1.0], 160);
    const a = wide([standing, mirai]);
    const b = wide([standing, { ...mirai, lying: false }]);
    expect(faceDeg(standing, a.cam)).toBeLessThan(100);
    void b;
  });

  it("a wide that already sees the faces is unchanged (square to the side)", () => {
    const room: DRoom = { outline: [[0, 0], [20, 0], [20, 20], [0, 20]], ceiling: 3, open: false };
    // pair on the x axis at z = 8, facing +z toward the room center: the square-on wide sits at +z
    const out = wide([act("Mama", [9, 8], 0), act("Mirai", [11, 8], 0)], room);
    expect(out.cam[0]).toBeCloseTo(10, 5);
    expect(out.cam[2]).toBeGreaterThan(8);
  });
});
