/** Koshakan full f1, meadow 259–291 s (the film's last minute): Mama spoke and the narrator read over a two and a
 *  close on her, Mirai in the frame with the back of her head to the lens (117–131°) for 8 s; the bedroom ended the
 *  same way. The "not from behind" rule asked the speaker only. Nobody in a two or a close shows the lens her back:
 *  Mirai turns hers on a held two-shot -> within 10 s she is not in it from behind. Actors: the meadow's narration
 *  beat 46 from the f1 critic. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector, type DirectorInput } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const L: DirectorInput = JSON.parse(readFileSync(new URL("./fixtures/kosh-meadow-hug.json", import.meta.url), "utf8"));
const tick = { kind: "tick", dt: 1 / 60, room: "meadow" } as DirectorInput["event"];
/** how far a face is turned from the lens, deg */
const turned = (a: DirectorInput["actors"][number], cam: V3): number => {
  const r = ((a.faceYaw ?? a.yaw) * Math.PI) / 180;
  const t = [cam[0] - a.pos[0], cam[2] - a.pos[1]];
  return (Math.acos(Math.max(-1, Math.min(1, (Math.sin(r) * t[0] + Math.cos(r) * t[1]) / Math.hypot(t[0], t[1])))) * 180) / Math.PI;
};

describe("nobody in a two or a close shows the lens her back", () => {
  for (const seed of [0.1, 0.5, 0.9]) {
    it(`rng ${seed}: Mirai turns her back on a held two after Mama's line -> not from behind within 10 s`, () => {
      const d = createDirector(() => seed, { style: "storybook" });
      d.step({ ...L, event: { ...tick, dt: 0.017 } });
      d.step({ ...L, event: { kind: "line", speaker: "Mama", durationS: 4, dt: 0.017, room: "meadow" } as DirectorInput["event"] });
      for (let k = 0; k < 400; k++) d.step({ ...L, event: tick });
      let o = d.step(L);
      const m = L.actors.find((a) => a.name === "Mirai")!;
      const away = (Math.atan2(m.pos[0] - o.cam[0], m.pos[1] - o.cam[2]) * 180) / Math.PI;
      const actors = L.actors.map((a) => (a.name === "Mirai" ? { ...a, faceYaw: away, yaw: away } : a));
      const mirai = actors.find((a) => a.name === "Mirai")!;
      for (let k = 0; k < 600; k++) o = d.step({ ...L, actors, event: tick });
      const p = ndcOf(mirai.head!, o.cam, o.look, o.fov ?? 50, 16 / 9);
      const inFrame = p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
      expect(!inFrame || o.plan === "wide" || o.plan === "master" || turned(mirai, o.cam) <= 110, `${o.cut} ${o.plan} ${o.cam} ${turned(mirai, o.cam).toFixed(0)}°`).toBe(true);
    });
  }
});
