import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DEvent, type DRoom, type DirectorInput } from "../src/runtime/stage/director.js";
import { insideInset } from "../src/runtime/stage/camera.js";
import type { V3 } from "../src/runtime/stage/camera.js";

// Koshakan bedroom, Nov 1: the close on Mirai stood behind the bed's footboard; the frame was wood, the lamb a
// sliver. The director gets a `clear(cam, look)` probe (the runtime raycasts the world) and moves off a blocked view.

const sq = (n: number): Array<[number, number]> => [[0, 0], [n, 0], [n, n], [0, n]];
const ROOM: DRoom = { outline: sq(6), ceiling: 2.6, open: false };
const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 0, height: 0.95, level: null, room: "r", walking: false, ...o });
const line = (speaker: string): DEvent => ({ kind: "line", speaker, durationS: 3, dt: 0 });

// a 1.2 m tall box (the bed foot) between x 1..5, z 1.6..2.4: anything whose sightline crosses it below 1.2 m is blocked
const blockedBy = (cam: V3, look: V3): boolean => {
  for (let i = 1; i < 40; i++) {
    const t = i / 40;
    const x = cam[0] + (look[0] - cam[0]) * t, y = cam[1] + (look[1] - cam[1]) * t, z = cam[2] + (look[2] - cam[2]) * t;
    if (x > 1 && x < 5 && z > 1.6 && z < 2.4 && y < 1.2) return true;
  }
  return false;
};
const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
};

describe("director: occluded frames", () => {
  it("never keeps a frame whose sightline the furniture blocks when a clear one exists", () => {
    // Mirai at the head of the bed facing the foot (south, -z), Mama beside
    const mirai = act("Mirai", [3, 3], { yaw: 180 });
    const mama = act("Mama", [4.6, 3.6], { yaw: 250, height: 1.65 });
    let blocked = 0, total = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng);
      for (const who of ["Mirai", "Mama", "Mirai", "Mirai", "Mama", "Mirai"]) {
        const inp: DirectorInput = { event: line(who), actors: [mirai, mama], room: ROOM, rng, clear: (c, l) => !blockedBy(c, l) };
        const out = d.step(inp);
        total++;
        if (blockedBy(out.cam, out.look)) blocked++;
        expect(out.plan).not.toBe("follow");  // nobody walks: a follow shows the back of a head and the floor ahead
        expect(insideInset(ROOM.outline, [out.cam[0], out.cam[2]])).toBe(true);
      }
    }
    expect(total).toBe(180);
    expect(blocked).toBe(0);
  });

  it("without a probe the frames are unchanged (pure director, old tests)", () => {
    const mirai = act("Mirai", [3, 3], { yaw: 180 });
    const mama = act("Mama", [4.6, 3.6], { yaw: 250, height: 1.65 });
    const a = createDirector(seeded(7)), b = createDirector(seeded(7));
    const ra = seeded(7), rb = seeded(7);
    for (const who of ["Mirai", "Mama", "Mirai"]) {
      const oa = a.step({ event: line(who), actors: [mirai, mama], room: ROOM, rng: ra });
      const ob = b.step({ event: line(who), actors: [mirai, mama], room: ROOM, rng: rb, clear: () => true });
      expect(ob.cam).toEqual(oa.cam);
    }
  });
});
