/** Koshakan meadow, Nov 3 (critic.jsonl 138 s, 252 s): a wide / push_in on the "room" of an open 40 m meadow stood
 *  11 m off, looking at the field's centre: the pair, sitting 2 m off that centre, filled 16 % of the frame.
 *  Outdoors there are no walls to show: the room subject is the actors. */
import { describe, it, expect } from "vitest";
import type { DActor, DRoom } from "../src/runtime/stage/director.js";
import { resolveMove, type Ctx } from "../src/runtime/stage/moves.js";

const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 90, height: 1.65, level: null, room: "meadow", walking: false, ...o });
const MEADOW: DRoom = { outline: [[-11.25, -23.25], [11.25, -23.25], [11.25, -0.75], [-11.25, -0.75]], ceiling: 3.5, open: true };
const ctx = (actors: DActor[]): Ctx => {
  let s = 7;
  return { actors, room: MEADOW, fov: 45, aspect: 16 / 9, durationS: 4, rng: () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296), clear: () => true };
};
const pt = (p: { pos: [number, number, number] }) => p.pos;

describe("a wide outdoors frames the actors, not the field", () => {
  const mama = act("Mama", [-0.7, -10.54]);
  const mirai = act("Mirai", [-0.58, -10.58], { height: 1.0 });
  it("the camera stands within 7 m of the pair", () => {
    const r = resolveMove("wide", { room: true }, ctx([mama, mirai]));
    const c = pt(r.from);
    expect(Math.hypot(c[0] + 0.64, c[2] + 10.56)).toBeLessThan(7);
  });
  it("the look is on the actors, not the field's centre", () => {
    const r = resolveMove("wide", { room: true }, ctx([mama, mirai]));
    const l = r.from.look;
    const lp = Array.isArray(l) ? l : null;
    if (lp) expect(Math.hypot(lp[0] + 0.64, lp[2] + 10.56)).toBeLessThan(2);
    else expect(["Mama", "Mirai"]).toContain((l as { actor: string }).actor);
  });
});
