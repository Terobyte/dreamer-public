/** Koshakan full f1, meadow 41 ("они обнимаются очень странно, мирай должна быть выше"): Mirai sat in Mama's lap
 *  (lap_cloud) and the beat "Mirai hugged Mama tight" gave her hug_cling, a standing clip: she came down off the lap
 *  onto the grass and hugged Mama round the waist. A child in the lap hugs from the lap: she keeps her lap clip, the
 *  mother keeps her lap hold; only a pair standing apart plays the chest-to-chest hug. */
import { describe, it, expect } from "vitest";
import { hugMode } from "../src/runtime/stage/places.js";

describe("a hug in the lap stays in the lap", () => {
  it("the child sitting in the lap keeps her lap clip", () => {
    expect(hugMode("lap_cloud", "lap_hold")).toBe("keep");
  });
  it("the mother holding a child in her lap keeps her lap hold", () => {
    expect(hugMode("lap_hold", "lap_cloud")).toBe("lap");
  });
  it("two standing actors hug chest to chest", () => {
    expect(hugMode("stand_idle", "idle_warm")).toBe("chest");
  });
});
