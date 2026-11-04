/** Koshakan k13, its opening replayed (the critic's input windows at each cut, the still gaps between them filled
 *  with their first step): a close on lying Mirai stood 0.27 m from Mama, inside her body, the frame her dress. A
 *  move is tried against its subjects (in view, seen, faced) and never against who stands at the lens. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";
import { replayProbe } from "../src/runtime/stage/probe-tape.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

type Taped = DirectorInput & { blocked?: number[][] };
const IN: Taped[] = JSON.parse(readFileSync(new URL("./fixtures/kosh-opening-stitched.json", import.meta.url), "utf8"));

describe("the camera does not stand in a body", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: no frame of the opening stands in a body or has a head at the lens`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      IN.forEach((i, k) => {
        const o = d.step({ ...i, clear: replayProbe(i.blocked ?? []) });
        for (const a of i.actors) {
          if (a.offstage) continue;
          const flat = Math.hypot(o.cam[0] - a.pos[0], o.cam[2] - a.pos[1]);
          expect(flat, `step ${k} ${a.name} cam ${o.cam} plan ${o.plan} move ${o.move}`).toBeGreaterThanOrEqual(0.3);
          const p = ndcOf(a.head!, o.cam, o.look, o.fov ?? i.fov ?? 50, i.aspect ?? 16 / 9);
          expect(p.depth > 0 && p.depth < 0.4 && Math.abs(p.x) < 1.5 && Math.abs(p.y) < 1.5, `step ${k} ${a.name}'s head at the lens, depth ${p.depth}`).toBe(false);
        }
      });
    });
  }
});
