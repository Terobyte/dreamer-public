/** Koshakan bedroom, Nov 3 (k2 27–29 s): the narrator read "Mama bent down..." and the camera stood behind Mama, her
 *  back filled the frame for two seconds. The face rule held only on a spoken line; on the narration and on the cut
 *  that followed it any side of her went. A plan on one person who is not walking is never taken from behind her. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[-3, -2], [1, -2], [1, 3.5], [-3, 3.5]], ceiling: 2.6, open: false };
const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
};
const DEG = Math.PI / 180;

describe("narration does not film a standing person from behind", () => {
  it("over many seeds the camera stays within 120 degrees of Mama's face on narrator beats about her", () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng, { style: "storybook" });
      // Mama stands by the bed, face toward -x (yaw 270); Mirai lies on the bed
      const mama: DActor = { name: "Mama", pos: [-1.65, 2.28], yaw: 270, faceYaw: 270, height: 1.6, head: [-1.65, 1.5, 2.28], level: null, room: "r", walking: false };
      const mirai: DActor = { name: "Mirai", pos: [-1.2, 2.6], yaw: 180, height: 1.0, head: [-1.2, 0.6, 2.9], level: null, room: "r", walking: false, lying: true };
      for (const ev of [{ kind: "narrator", speaker: "Mama", durationS: 5, dt: 0.5, tags: {} }, { kind: "narrator", speaker: "Mama", durationS: 5, dt: 0.5, tags: {} }]) {
        for (let k = 0; k < 6; k++) {
          const out = d.step({ event: (k ? { kind: "tick", dt: 0.5 } : ev) as any, actors: [mama, mirai], room: ROOM, rng });
          if (out.plan === "wide" || out.plan === "master") continue;
          const toCam = Math.atan2(out.cam[0] - mama.pos[0], out.cam[2] - mama.pos[1]) / DEG;
          const off = Math.abs((((toCam - 270) % 360) + 540) % 360 - 180);
          if (off > 120 && bad.length < 6) bad.push(`seed ${seed} ${out.plan}/${out.move} off ${off.toFixed(0)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);
});
