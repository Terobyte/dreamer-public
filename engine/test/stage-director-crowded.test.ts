/** Squidward, Nov 3 ("32 секунда ужасно, камера откуда-то из мольберта"): the storybook director's fallback frame
 *  (MOVE_OUT_OF_FRAME: the picked move lost the subject) took the base frame without asking the probe; it stood
 *  30 cm from the easel's canvas, a third of the frame was canvas. Every frame the director keeps asks `clear`. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ROOM: DRoom = { outline: [[0, 0], [6, 0], [6, 6], [0, 6]], ceiling: 2.6, open: false };
const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 0, height: 1.8, level: null, room: "r", walking: false, ...o });
const line = (speaker: string): DEvent => ({ kind: "line", speaker, durationS: 3, dt: 0.5, tags: {} });
const narr = (): DEvent => ({ kind: "narrator", durationS: 3, dt: 0.5, tags: {} } as DEvent);
const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
};
// the easel stands in front of Squidward: a camera within 0.9 m of it sees canvas across the frame
const EASEL: [number, number] = [3, 3.9];
const nearEasel = (c: V3): boolean => Math.hypot(c[0] - EASEL[0], c[2] - EASEL[1]) < 0.9;

describe("director: every kept frame asks the probe", () => {
  it("no frame stands in the easel when the room has clear spots", () => {
    const squid = act("Squidward", [3, 3.2], { yaw: 0 });
    const sponge = act("SpongeBob", [1.2, 4.6], { yaw: 120, height: 1.0 });
    let bad = 0;
    const where: string[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng, { style: "storybook" });
      let t = 0;
      for (const ev of [narr(), line("Squidward"), narr(), line("SpongeBob"), line("Squidward"), narr(), line("Squidward")]) {
        for (let k = 0; k < 6; k++) {
          t += 0.5;
          const out = d.step({ event: ev, actors: [squid, sponge], room: ROOM, rng, clear: (c) => !nearEasel(c) });
          if (nearEasel(out.cam)) {
            bad++;
            if (where.length < 3) where.push(`${seed} ${out.plan} ${(out.warnings ?? []).join(",")}`);
          }
        }
      }
    }
    expect(where).toEqual([]);
    expect(bad).toBe(0);
  });

  it("a pair no frame can hold together: the speaker gets a close, not a frame of chairs (Squidward 25 s)", () => {
    // SpongeBob at the door, Squidward at the easel 4.5 m off, a row of chairs between them: from any spot one head
    // is behind a chair
    const room: DRoom = { outline: [[0, 0], [8, 0], [8, 8], [0, 8]], ceiling: 2.6, open: false };
    const sponge = act("SpongeBob", [1.2, 4], { yaw: 90, height: 1.0 });
    const squid = act("Squidward", [5.8, 4], { yaw: 270 });
    const chairs = (c: V3, l: V3): boolean => {
      for (let i = 1; i < 40; i++) {
        const t = i / 40, x = c[0] + (l[0] - c[0]) * t, y = c[1] + (l[1] - c[1]) * t;
        if (x > 3 && x < 4 && y < 1.9) return true;
      }
      return false;
    };
    const head: V3 = [1.2, 0.93, 4];
    let lost = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng, { style: "storybook" });
      for (let k = 0; k < 4; k++) {
        const out = d.step({ event: line("SpongeBob"), actors: [sponge, squid], room, rng, clear: (c, l) => !chairs(c, l) });
        const f = [out.look[0] - out.cam[0], out.look[2] - out.cam[2]], h = [head[0] - out.cam[0], head[2] - out.cam[2]];
        const cos = (f[0] * h[0] + f[1] * h[1]) / (Math.hypot(f[0], f[1]) * Math.hypot(h[0], h[1]) || 1);
        if (chairs(out.cam, head) || cos < Math.cos((30 * Math.PI) / 180)) lost++;
      }
    }
    expect(lost).toBe(0);
  });
});
