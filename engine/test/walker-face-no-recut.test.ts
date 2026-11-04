/** Koshakan k9 24.3–25.8 s: Mama walked to the bed and the cut id went 5 -> 19 -> 49 -> 52 in a second and a half.
 *  The rule "a face that turned more than 30° (or past 90° to the camera) ends the plan" cut on every tick while
 *  she walked: her face turned with every step and each new frame had her back too. A walker's turning face does
 *  not cut the frame (the walk is followed). Inputs: the k9 critic's recorded steps with the probe's answers. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";
import { replayProbe } from "../src/runtime/stage/probe-tape.js";

type Taped = DirectorInput & { blocked?: number[][] };
const IN: Taped[] = JSON.parse(readFileSync(new URL("./fixtures/kosh-walk-to-bed.json", import.meta.url), "utf8"));

describe("a walker's turning face does not cut the frame", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: the cut id grows by at most 4 in the 60 steps from Mama's walk`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      const cuts: number[] = [];
      IN.forEach((i, k) => {
        const o = d.step({ ...i, clear: replayProbe(i.blocked ?? []) });
        if (k >= 180 && cuts[cuts.length - 1] !== o.cut) cuts.push(o.cut);
      });
      // the cut id counts every cut the director made, shown or swallowed; 13 in 0.2 s reset the once-per-cut recut
      expect(Math.floor(cuts[cuts.length - 1]) - Math.floor(cuts[0]), JSON.stringify(cuts)).toBeLessThanOrEqual(4);
    });
  }
});

describe("a face that keeps turning cuts once per 30°, not on every tick", () => {
  // Koshakan k10 24.7–25.2 s: Mama stopped at the bed and sat, turning; the face rule cut on every tick (cut id
  // 5 -> 26 -> 29) because its base face was kept while the cut was swallowed. Koshakan k12 25.3–30.3 s: Mama sat
  // with her back to the camera; the rule cut on every tick for the 5 s the too-early cut was swallowed, and the cut
  // that passed at 30.3 s was id 281. The hold is longer than the style's shortest plan, so the swallowed cut shows.
  const W: Taped[] = JSON.parse(readFileSync(new URL("./fixtures/kosh-wake-line.json", import.meta.url), "utf8"));
  const last = W[W.length - 1];
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: Mama turning 180° in 1 s after her line and holding 6 s -> the cut id grows by at most 4`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step({ ...last, event: { kind: "tick", dt: 0.017, room: "bedroom" } });
      let o = d.step({ ...last });
      const c0 = o.cut;
      for (let k = 1; k <= 420; k++) {
        const turn = 3 * Math.min(k, 60);
        const actors = last.actors.map((a) => (a.name === "Mama" ? { ...a, yaw: (a.yaw + turn) % 360, faceYaw: ((a.faceYaw ?? a.yaw) + turn) % 360 } : a));
        o = d.step({ ...last, actors, event: { kind: "tick", dt: 1 / 60, room: "bedroom" } });
      }
      expect(Math.floor(o.cut) - Math.floor(c0), `${c0} -> ${o.cut}`).toBeLessThanOrEqual(4);
    });
  }
});

describe("a face turned from the camera owes one cut, not one per tick", () => {
  // Koshakan k12 25.3–30.3 s: Mama sat with her back to the camera; "past 90° to the camera" cut on every tick, each
  // swallowed (sooner than the style's shortest plan) and each a new cut id; at 30.3 s the cut passed as id 281
  const ROOM = { outline: [[0, 0], [6, 0], [6, 6], [0, 6]], ceiling: 2.6, open: false, floorY: 0 } as unknown as DirectorInput["room"];
  const act = (name: string, pos: [number, number], yaw: number) => ({ name, pos, yaw, height: 1.6, level: null, room: "r", walking: false, head: [pos[0], 1.5, pos[1]] }) as unknown as DirectorInput["actors"][number];
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: A speaks, turns her back in 1 s and holds it 7 s -> the cut id grows by at most 2`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      const A = act("A", [2, 3], 90), B = act("B", [4, 3], 270);
      let o = d.step({ event: { kind: "line", speaker: "A", durationS: 2, dt: 0, tags: { look: true }, room: "r" } as any, actors: [A, B], room: ROOM, aspect: 16 / 9 });
      const c0 = o.cut;
      for (let k = 1; k <= 480; k++) {
        const turned = { ...A, yaw: (90 + 3 * Math.min(k, 60)) % 360 };
        o = d.step({ event: { kind: "tick", dt: 1 / 60, room: "r" } as any, actors: [turned, B], room: ROOM, aspect: 16 / 9 });
      }
      expect(Math.floor(o.cut) - Math.floor(c0), `${c0} -> ${o.cut}`).toBeLessThanOrEqual(2);
    });
  }
});
