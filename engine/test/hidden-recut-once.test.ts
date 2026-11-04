/** Koshakan k8 37–40 s (the film's end): Mirai lay on her side, her face to the wall; the probe saw it from almost
 *  nowhere. The held frame lost her, was cut again 0.75 s later, the new frame lost her too: 37 -> 37.004 -> .005
 *  -> .006 -> .007, pull_out, medium, pull_out, close, the camera jumping every half second. A frame that hides a
 *  head is cut again once; the second frame is kept. Actors from the k4 replay fixture's last input. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ALL: DirectorInput[] = JSON.parse(readFileSync(new URL("./fixtures/kosh-wake-line.json", import.meta.url), "utf8"));
const last = ALL[ALL.length - 1];
const IN: DirectorInput = { event: last.event, actors: last.actors, room: last.room, fov: last.fov, aspect: last.aspect };
const mirai = IN.actors.find((a) => a.name === "Mirai")!;
// nothing sees Mirai's face (within 0.3 m of her head)
const wall = (_cam: V3, look: V3): boolean => Math.hypot(look[0] - mirai.head![0], look[1] - mirai.head![1], look[2] - mirai.head![2]) > 0.3;
const tick = { kind: "tick", dt: 1 / 60, room: "bedroom" } as DirectorInput["event"];

describe("a frame that hides a head is cut again once", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: 6 s of ticks after the last beat, at most one recut`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step({ ...IN, event: { ...tick, dt: 0.017 }, clear: wall });
      let o = d.step({ ...IN, event: { ...tick, tags: { last: true } } as DirectorInput["event"], clear: wall });
      const cuts = [o.cut];
      for (let k = 0; k < 6 * 60; k++) {
        o = d.step({ ...IN, event: tick, clear: wall });
        if (o.cut !== cuts[cuts.length - 1]) cuts.push(o.cut);
      }
      expect(cuts.length, JSON.stringify(cuts)).toBeLessThanOrEqual(2);
    });
  }
});

describe("hidden-head recuts are at least the style's shortest plan apart", () => {
  // Koshakan k10 23.7–25.2 s: three recuts in 1.5 s; the cut id grew under them (Mama sitting down), so the
  // once-per-cut cap never held. However the cut id grows, a recut waits asl.min (storybook 5 s) after the last one.
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: a new beat every 10 ticks for 3 s, Mirai's face hidden -> at most one recut`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step({ ...IN, event: { ...tick, dt: 0.017 }, clear: wall });
      let o = d.step({ ...IN, event: { ...tick, tags: { last: true } } as DirectorInput["event"], clear: wall });
      const recuts = new Set<number>();
      for (let k = 0; k < 3 * 60; k++) {
        o = d.step({ ...IN, event: { ...tick, beat: Math.floor(k / 10) } as DirectorInput["event"], clear: wall });
        if (o.cut % 1 !== 0) recuts.add(o.cut);
      }
      expect(recuts.size, JSON.stringify([...recuts])).toBeLessThanOrEqual(1);
    });
  }
});
