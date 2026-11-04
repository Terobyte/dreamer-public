/** Koshakan k3 27.7–39.3 s: Mama sits on the bed and says "Wake up, Koshakanym" to Mirai lying in it; the frame
 *  held Mama's close alone and Mirai's head stayed under the frame (head_ndc y −1.3…−1.46). The ots became a two
 *  for a lying listener, the two found no point 1.4 m off Mama's face in a 3.6 m room, and the fallback was the
 *  speaker's close with MOVE_OUT_OF_FRAME. A line said to someone holds that someone. Inputs are the 60 the
 *  director saw up to the cut (150 steps, the probe's answers on them), from the k4 critic row t 32.1.
 *  Why: a lying actor had no face point, the probe asked about her head bone and the pillow hid it from every
 *  camera; her face is over it. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import { replayProbe } from "../src/runtime/stage/probe-tape.js";
import type { V3 } from "../src/runtime/stage/camera.js";

type Taped = DirectorInput & { blocked?: number[][] };
const INPUTS: Taped[] = JSON.parse(readFileSync(new URL("./fixtures/kosh-wake-line.json", import.meta.url), "utf8"));
const last = INPUTS[INPUTS.length - 1];
const mama = last.actors.find((a) => a.name === "Mama")!;
const mirai = last.actors.find((a) => a.name === "Mirai")!;

const inFrame = (p: V3, o: { cam: V3; look: V3; fov?: number }): boolean => {
  const n = ndcOf(p, o.cam, o.look, o.fov ?? last.fov ?? 50, last.aspect ?? 16 / 9);
  return n.depth > 0.2 && Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1;
};

describe("a line to a lying listener holds her", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: Mama's wake-up line keeps Mirai's head in the frame`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      const step = (i: Taped) => d.step({ ...i, clear: replayProbe(i.blocked ?? []) });
      let o = step(INPUTS[0]);
      for (const i of INPUTS.slice(1)) o = step(i);
      expect(inFrame(mama.head!, o), `mama, cam ${o.cam} plan ${o.plan}`).toBe(true);
      expect(inFrame(mirai.head!, o), `mirai, cam ${o.cam} look ${o.look} plan ${o.plan} ${o.warnings ?? ""}`).toBe(true);
    });
  }
});

describe("the probe asks about a lying face, not the head bone in the pillow", () => {
  // the pillow: anything under 0.72 m within 0.25 m of Mirai's head bone is hidden; her face above it is seen
  const h = mirai.head!;
  const pillow = (_cam: V3, look: V3): boolean => !(look[1] < h[1] + 0.035 && Math.hypot(look[0] - h[0], look[2] - h[2]) < 0.25);
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: the wake-up line, the pillow probe, Mirai in the frame`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step({ ...last, event: { kind: "tick", dt: 0.017, room: "bedroom" }, clear: pillow });
      const o = d.step({ ...last, clear: pillow });
      expect(inFrame(mama.head!, o), `mama, cam ${o.cam} plan ${o.plan}`).toBe(true);
      expect(inFrame(mirai.head!, o), `mirai, cam ${o.cam} plan ${o.plan} ${o.warnings ?? ""}`).toBe(true);
    });
  }
});
