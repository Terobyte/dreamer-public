/** Squidward v51/v52 66–73 s: the wide stood behind the easel, Squidward's head behind the canvas. The hidden-head
 *  recut (20 -> 20.001) landed on the very frame it left (553.25, 1.5, 3.75): the fallback's last link takes a frame
 *  holding the heads without asking the probe. A recut for a hidden head never lands on the frame it left. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ALL: DirectorInput[] = JSON.parse(readFileSync(new URL("./fixtures/kosh-wake-line.json", import.meta.url), "utf8"));
const last = ALL[ALL.length - 1];
const IN: DirectorInput = { event: last.event, actors: last.actors, room: last.room, fov: last.fov, aspect: last.aspect };
const mirai = IN.actors.find((a) => a.name === "Mirai")!;
// nothing sees Mirai's face: every frame hides it, the recut has no clear frame to go to
const wall = (_cam: V3, look: V3): boolean => Math.hypot(look[0] - mirai.head![0], look[1] - mirai.head![1], look[2] - mirai.head![2]) > 0.3;
const tick = { kind: "tick", dt: 1 / 60, room: "bedroom" } as DirectorInput["event"];
const same = (a: V3, b: V3): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.05;

describe("a hidden-head recut never lands on the frame it left", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: 6 s of ticks with Mirai's face hidden everywhere -> no new cut id on the same frame`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step({ ...IN, event: { ...tick, dt: 0.017 }, clear: wall });
      let o = d.step({ ...IN, event: { ...tick, tags: { last: true } } as DirectorInput["event"], clear: wall });
      // a recut with nowhere new to go is no cut at all: the frame stays and keeps its cut id
      for (let k = 0; k < 6 * 60; k++) {
        const n = d.step({ ...IN, event: tick, clear: wall });
        if (n.cut !== o.cut) expect(same(o.cam, n.cam) && same(o.look, n.look), `${o.cut} ${o.plan} ${o.cam} -> ${n.cut} ${n.plan} ${n.cam} ${n.warnings}`).toBe(false);
        o = n;
      }
    });
  }
});
