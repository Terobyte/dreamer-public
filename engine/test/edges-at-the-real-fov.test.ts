/** Koshakan k6 9.4–16.9 s: the narration's two-shot held Mama's head on the right edge (ndc 0.94), her body cut.
 *  The frame had no fov of its own; the page shot it at its camera's 70°, cleanEdges judged it at 50°, saw Mama
 *  past the edge (1.4, "out") and let it be. A frame without a fov is judged at the fov the page shoots it with. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { cleanEdges, createDirector, type DirectorInput, type DirectorOut } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const IN: DirectorInput = JSON.parse(readFileSync(new URL("./fixtures/kosh-opening-narration.json", import.meta.url), "utf8"));
const frame = { plan: "two", cam: [-2.16, 1.39, 1.33], look: [-1.6235, 0.78, 2.4834], cut: 1 } as DirectorOut;
const reach = (o: DirectorOut, h: V3, fov: number): number => {
  const p = ndcOf(h, o.cam, o.look, o.fov ?? fov, 16 / 9);
  return p.depth <= 0.2 ? Infinity : Math.max(Math.abs(p.x), Math.abs(p.y));
};

describe("edges are judged at the page's fov", () => {
  it("the k6 two-shot: no head left between 0.9 and 1.3 of the frame at 70°", () => {
    const o = cleanEdges(frame, IN.actors, 16 / 9, { fov: 70 });
    for (const a of IN.actors) {
      const r = reach(o, a.head!, 70);
      expect(r <= 0.9 || r >= 1.3, `${a.name} ${r}`).toBe(true);
    }
  });
  it("the director hands its input fov to the edge check", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    for (let k = 0; k < 3; k++) {
      const o = d.step({ ...IN, event: k === 0 ? IN.event : { kind: "tick", dt: 1 / 60, room: "bedroom" } });
      for (const a of IN.actors) {
        const r = reach(o, a.head!, IN.fov!);
        expect(r <= 0.9 || r >= 1.3, `${a.name} ${r} fov ${o.fov}`).toBe(true);
      }
    }
  });
});
