/** Squidward v41/v42 151–154 s: follow_side on SpongeBob leaving Squidward, who stood a metre off him, came out still
 *  2.2 m from Squidward, 1.1 m high: the frame held him from the knees to the chest, his head over the top edge.
 *  The walk shot framed "head to feet" by the head bone, and his head bone is mid-body (1.17 m of 1.8 m).
 *  Replayed from the director's own inputs recorded in the v42 film (critic cut rows). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createDirector, type DActor, type DirectorInput } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const F: Record<string, { inputs: DirectorInput[] }> = JSON.parse(readFileSync(new URL("./fixtures/v42-pine-cuts.json", import.meta.url), "utf8"));

/** nearer than it takes to frame him whole, he is whole in (top and feet) or not in at all */
function halfIn(cam: V3, look: V3, fov: number, aspect: number, a: DActor): boolean {
  const dl = Math.hypot(a.pos[0] - cam[0], a.pos[1] - cam[2]);
  if (dl >= a.height / (2 * 0.85 * Math.tan((fov / 2) * (Math.PI / 180)))) return false;
  const pts = [[a.pos[0], a.height, a.pos[1]], [a.pos[0], 0, a.pos[1]]].map((p) => ndcOf(p as V3, cam, look, fov, aspect));
  const whole = pts.every((n) => n.depth > 0.1 && Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1);
  const any = pts.some((n) => n.depth > 0.1 && Math.abs(n.x) <= 1);
  return !whole && any;
}

describe("v42 151 s replayed: the walk shot holds Squidward whole, not chest down", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      const inputs = F["151.23"].inputs;
      let o = d.step(inputs[0]);
      for (const inp of inputs.slice(1)) o = d.step(inp);
      const sq = inputs[inputs.length - 1].actors.find((a) => a.name === "Squidward")!;
      expect(halfIn(o.cam, o.look, o.fov ?? 50, 16 / 9, sq), `cam ${o.cam} move ${o.move}`).toBe(false);
    });
  }
});
