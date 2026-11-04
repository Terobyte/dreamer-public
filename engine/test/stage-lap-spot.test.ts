/** Koshakan meadow, f2: "Mirai climbed into Mama's lap" put her on the grass 0.12 m in front of Mama, facing her;
 *  Mama's lap_hold closed over her and it looked as if Mama sat on the child. Sonnet's hand-made demo
 *  (anymove/runs/koshakan/demo/story.js:159-171) is the reference: the child sits in the lap facing the same way as
 *  the holder, 0.12 m forward and 0.3 m to her left, her seat at the lap's height; a hug from the lap turns her to
 *  face the holder 0.26 m in front. Heights are over the holder's support: the actor already sets each clip's skin
 *  on its support (Г4, actors.ts), so a lift by contact_y on top floated Mama 0.25 m over the grass (f3). The demo's
 *  Mama sat 0.067 m into the grass, so its lap is 0.27 + 0.067 over her skin. */
import { describe, it, expect } from "vitest";
import { lapSpot, lapHugSpot, hugMode } from "../src/runtime/stage/places.js";

const close = (a: number[], b: number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 2));

describe("a child in the lap, as in the demo", () => {
  it("sits facing the holder's way, 0.12 m forward and 0.3 m to her left, at lap height", () => {
    // demo: Mama at [1.15, 0.25, -7] yaw 180, Mirai lap_cloud (contact 0.324) at [0.85, -0.05, -7.12] yaw 180
    const s = lapSpot([1.15, -7], 180, 0);
    close(s.at, [0.85, -7.12]);
    expect(s.yaw).toBe(180);
    expect(s.y).toBeCloseTo(0.34, 2);
    expect(lapSpot([1.15, -7], 180, 0.5).y).toBeCloseTo(0.84, 2);
  });

  it("faces the +Z holder the same way: forward is +Z, left is +X", () => {
    const s = lapSpot([0, 0], 0, 0);
    close(s.at, [0.3, 0.12]);
    expect(s.yaw).toBe(0);
  });

  it("hugs from the lap face to face, 0.26 m in front, a little higher", () => {
    // demo: Mama yaw 90 at [1.15, -7], Mirai hug_cling (contact 0.261) at [1.41, 0.05, -7] yaw 270
    const s = lapHugSpot([1.15, -7], 90, 0);
    close(s.at, [1.41, -7]);
    expect(s.yaw).toBe(270);
    expect(s.y).toBeCloseTo(0.38, 2);
  });

  it("a hug clip for the child in the lap is a hug from the lap, not a step onto the grass", () => {
    expect(hugMode("lap_cloud", "lap_hold")).toBe("lapHug");
    expect(hugMode("lap_hold", "lap_cloud")).toBe("lap");
    expect(hugMode("stand_idle", "idle_warm")).toBe("chest");
  });
});
