/** Koshakan meadow, Nov 3 ("обнимки ужасные"): Mirai stayed where she had sat in Mama's lap, 0.12 m off, and played
 *  hug_cling standing: her body was inside Mama's knees and Mama's hug_hold closed over her head. The clips were made as
 *  kneeling mother + standing child, chest to chest: in a hug the two bodies touch, never overlap. */
import { describe, it, expect } from "vitest";
import { hugSpot } from "../src/runtime/stage/places.js";

describe("a hug puts the pair chest to chest", () => {
  it("a child inside the mother's body steps back until the capsules touch", () => {
    const p = hugSpot([0.12, 0], [0, 0], 0.18, 0.3)!;
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(0.48, 6);
    expect(p[1]).toBeCloseTo(0, 6);
  });
  it("a pair already apart is left where it stands", () => {
    expect(hugSpot([0.6, 0], [0, 0], 0.18, 0.3)).toBeNull();
  });
});
