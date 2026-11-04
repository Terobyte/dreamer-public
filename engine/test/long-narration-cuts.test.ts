/** Koshakan k5 3.8–15.3 s: the opening narration ran 10.4 s over one still wide, the next one 7.3 s over the same
 *  wide again; the film opened on 20 s of one frame. storybook holds a plan 5–8 s (asl): a narration longer than
 *  asl.max is cut into even pieces, each its own plan. Input from the k5 critic row t 3.77 (the cut of beat 0). */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";

const IN: DirectorInput = JSON.parse(readFileSync(new URL("./fixtures/kosh-opening-narration.json", import.meta.url), "utf8"));
const tick = { kind: "tick", dt: 1 / 60, room: "bedroom" } as DirectorInput["event"];

const run = (seed: number, durationS: number): Array<{ t: number; cut: number; plan: string }> => {
  const d = createDirector(() => seed, { style: "storybook" });
  d.step({ ...IN, event: { ...tick, dt: 0.017 } });
  const cuts: Array<{ t: number; cut: number; plan: string }> = [];
  let t = 0;
  for (let k = 0; k < Math.round(durationS * 60); k++) {
    const o = d.step({ ...IN, event: k === 0 ? { ...IN.event, durationS } : tick });
    if (!cuts.length || cuts[cuts.length - 1].cut !== o.cut) cuts.push({ t, cut: o.cut, plan: o.plan });
    t += 1 / 60;
  }
  return cuts;
};

describe("a narration longer than the style's longest plan is cut", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: 10.4 s of narration -> two plans, each 4–8 s`, () => {
      const c = run(seed, 10.4);
      expect(c.length, JSON.stringify(c)).toBe(2);
      expect(c[1].t).toBeGreaterThan(4);
      expect(c[1].t).toBeLessThan(6.5);
      expect(c[1].plan).not.toBe(c[0].plan);
    });
  }
  it("a narration within asl.max keeps its one plan", () => {
    expect(run(0.5, 7.3).length).toBe(1);
  });
});
