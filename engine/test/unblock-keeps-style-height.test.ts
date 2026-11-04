/** Koshakan k9 4.8–16 s: the opening narration was shot from 2.4 m, looking down on Mama's head in the corner of the
 *  frame. No frame at storybook's 1.1–1.5 m saw lying Mirai's face (to the wall), so the fallback's unblock climbed
 *  up to 1.1 m over the wide toward the ceiling. The fallback keeps the style's height; a face the probe cannot
 *  see from there is not looked for under the ceiling. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const IN: DirectorInput = JSON.parse(readFileSync(new URL("./fixtures/kosh-opening-narration.json", import.meta.url), "utf8"));
const mirai = IN.actors.find((a) => a.name === "Mirai")!;
// Mirai's face is seen only from over 1.8 m (over the blanket's edge)
const wall = (cam: V3, look: V3): boolean => cam[1] > 1.8 || Math.hypot(look[0] - mirai.head![0], look[1] - mirai.head![1], look[2] - mirai.head![2]) > 0.3;

describe("the fallback frame keeps the style's camera height", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: the opening narration, Mirai's face hidden low -> camera at most 1.5 m`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step({ ...IN, event: { kind: "tick", dt: 0.017, room: "bedroom" }, clear: wall });
      const o = d.step({ ...IN, clear: wall });
      expect(o.cam[1], `cam ${o.cam} plan ${o.plan} ${o.warnings ?? ""}`).toBeLessThanOrEqual(1.5 + 1e-6);
    });
  }
});
