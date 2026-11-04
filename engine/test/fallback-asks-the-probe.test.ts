/** Squidward v53 66.6–72.1 s: SpongeBob's line took the wide behind the easel (the probe saw Squidward's face at the
 *  cut); then he turned and his face went behind the canvas. The hidden-head recut found no frame of its own the probe
 *  passed (the base and the wide both behind the easel) and held the hidden frame 6 s, though an over-the-shoulder on
 *  the same side saw both (the film cut to it at 72.6 s). A hidden head is recut once per shortest plan (5 s here), the line
 *  came 2 s after the last recut: within 4 s it is recut. With no frame of its own the fallback tries the other plans.
 *  Inputs: the v53 critic's stitched cut windows up to that line, with the probe's answers; after it, the world's
 *  "no" for Squidward's face from the easel side (z > 3.3 m, x > 552.8 m). */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";
import { replayProbe } from "../src/runtime/stage/probe-tape.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

type Taped = DirectorInput & { blocked?: number[][] };
const IN: Taped[] = JSON.parse(readFileSync(new URL("./fixtures/squid-easel-line.json", import.meta.url), "utf8"));
const line = IN[IN.length - 1];
const sq = line.actors.find((a) => a.name === "Squidward")!;
const near = (p: V3, q: V3): boolean => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.05;
/** the canvas: Squidward's face and eye are hidden from the easel side */
const canvas = (cam: V3, look: V3): boolean => !(cam[2] > 3.3 && cam[0] > 552.8 && (near(look, sq.face!) || near(look, sq.eye!)));
const tick = { kind: "tick", dt: 1 / 60, room: "livingroom" } as DirectorInput["event"];

describe("with no frame of its own the fallback tries the other plans", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: Squidward's face behind the canvas after SpongeBob's line -> seen again within 4 s`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      let o = d.step({ ...IN[0], clear: replayProbe(IN[0].blocked ?? []) });
      for (const i of IN.slice(1)) o = d.step({ ...i, clear: replayProbe(i.blocked ?? []) });
      const tape = replayProbe(line.blocked ?? []);
      const clear = (c: V3, l: V3): boolean => tape(c, l) && canvas(c, l);
      for (let k = 0; k < 240; k++) o = d.step({ ...line, event: tick, clear });
      const p = ndcOf(sq.head!, o.cam, o.look, o.fov ?? 50, 16 / 9);
      const inFrame = p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
      expect(!inFrame || (canvas(o.cam, sq.face!) && canvas(o.cam, sq.eye!)), `${o.cut} ${o.plan} ${o.cam} ${o.warnings}`).toBe(true);
    });
  }
});
