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
  // 5 -> 26 -> 29) because its base face was kept while the cut was swallowed
  const W: Taped[] = JSON.parse(readFileSync(new URL("./fixtures/kosh-wake-line.json", import.meta.url), "utf8"));
  const last = W[W.length - 1];
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: Mama turning 180° in 1 s after her line and holding 2 s -> the cut id grows by at most 4`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step({ ...last, event: { kind: "tick", dt: 0.017, room: "bedroom" } });
      let o = d.step({ ...last });
      const c0 = o.cut;
      for (let k = 1; k <= 180; k++) {
        const turn = 3 * Math.min(k, 60);
        const actors = last.actors.map((a) => (a.name === "Mama" ? { ...a, yaw: (a.yaw + turn) % 360, faceYaw: ((a.faceYaw ?? a.yaw) + turn) % 360 } : a));
        o = d.step({ ...last, actors, event: { kind: "tick", dt: 1 / 60, room: "bedroom" } });
      }
      expect(Math.floor(o.cut) - Math.floor(c0), `${c0} -> ${o.cut}`).toBeLessThanOrEqual(4);
    });
  }
});
