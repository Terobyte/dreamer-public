/** A two-shot holds its pair, not the field (Koshakan f7 meadow 67–240 s: Mama knelt with Mirai in her lap, the base
 *  two stood its fixed 3 m off at the page's 70°, the pair a quarter of the frame for 94 s of the hug). The distance
 *  comes from the pair's real height (heads, a kneeling one included) and width at the frame's fov. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const field: DRoom = { outline: [[-20, -20], [20, -20], [20, 20], [-20, 20]], ceiling: 3.5, open: true };
const act = (name: string, pos: [number, number], height: number, headY: number, yaw: number): DActor =>
  ({ name, pos, yaw, height, head: [pos[0], headY, pos[1]], level: null, room: "r", walking: false });

/** the pair's height (floor to just above the top head) as a share of the frame, at the mid head */
const fill = (o: { cam: any; look: any; fov?: number }, actors: DActor[], fov: number): number => {
  const heads = actors.map((a) => a.head!);
  const mid = [0, 1, 2].map((k) => heads.reduce((s, h) => s + h[k]!, 0) / heads.length);
  const depth = ndcOf(mid as any, o.cam, o.look, o.fov ?? fov, 16 / 9).depth;
  return (Math.max(...heads.map((h) => h[1])) + 0.25) / (2 * depth * Math.tan(((o.fov ?? fov) * Math.PI) / 360));
};

describe("a two-shot holds its pair", () => {
  it("a kneeling hug in an open field fills more than 0.4 of the frame at 70°", () => {
    const actors = [act("Mama", [-0.7, -9.9], 1.65, 0.85, 75), act("Mirai", [-0.4, -9.8], 0.95, 0.77, 255)];
    const o = createDirector(() => 0.5).step({ event: { kind: "line", speaker: "Mama", durationS: 3, dt: 0, shot: "two" }, actors, room: field, fov: 70 });
    expect(o.plan).toBe("two");
    expect(fill(o, actors, 70)).toBeGreaterThan(0.4);
  });
  it("a standing pair 1.3 m apart is still held whole (feet to heads inside the frame)", () => {
    const actors = [act("Mama", [-0.7, -9.9], 1.65, 1.55, 90), act("Mirai", [0.6, -9.9], 0.95, 0.88, 270)];
    const o = createDirector(() => 0.5).step({ event: { kind: "line", speaker: "Mama", durationS: 3, dt: 0, shot: "two" }, actors, room: field, fov: 70 });
    const f = fill(o, actors, 70);
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.95);
  });
});
