/** Koshakan k2, Nov 3 (29–31 s): a push_in on Mama began with lying Mirai's head on the bottom edge (ndc y -1.17) and
 *  slid it out over two seconds; cleanEdges judged a move by its end frame only, where she was already gone. A move's
 *  start frame is held to the same rule: nobody's head on an edge where the move begins either. */
import { describe, it, expect } from "vitest";
import { cleanEdges, type DActor } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

type V3 = [number, number, number];
const mama: DActor = { name: "Mama", pos: [0, 0], yaw: 0, height: 1.6, head: [0, 1.5, 0], level: null, room: "r", walking: false };
const mirai: DActor = { name: "Mirai", pos: [0.3, 1.5], yaw: 0, height: 1.0, head: [0.3, 0.53, 1.5], level: null, room: "r", walking: false, lying: true };
const reach = (h: V3, cam: V3, look: V3, fov: number) => {
  const p = ndcOf(h, cam, look, fov, 16 / 9);
  return p.depth <= 0.2 ? Infinity : Math.max(Math.abs(p.x), Math.abs(p.y));
};

describe("a move's start frame cuts nobody either", () => {
  it("the push_in's start had Mirai's head on the bottom edge: fixed, the end frame kept", () => {
    const out: any = { plan: "close", cam: [0, 1.3, 3], look: [0, 1.3, 0], fov: 50, end: [0, 1.3, 2], lookEnd: [0, 1.5, 0], fovEnd: 50, cut: 1, move: "push_in" };
    const r0 = reach(mirai.head!, out.cam, out.look, out.fov);
    expect(r0).toBeGreaterThan(0.9);
    expect(r0).toBeLessThan(1.3);  // the fixture: cut at the start
    const fixed: any = cleanEdges(out, [mama, mirai], 16 / 9);
    const r = reach(mirai.head!, fixed.cam, fixed.look, fixed.fov ?? 50);
    expect(r <= 0.9 || r >= 1.3).toBe(true);
    expect(reach(mama.head!, fixed.cam, fixed.look, fixed.fov ?? 50)).toBeLessThanOrEqual(0.9);
    expect(fixed.end).toEqual(out.end);
    expect(fixed.lookEnd).toEqual(out.lookEnd);
  });
});
