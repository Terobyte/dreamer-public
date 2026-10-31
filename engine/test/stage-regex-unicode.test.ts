import { describe, it, expect } from "vitest";
import { stageRegex, type Place } from "../src/runtime/stage/places.js";

const PLACES: Place[] = [
  { name: "armchair", id: "a", kind: "sit", room: "r", level: "L0", at: [4.22, 3.26], yaw: 180, look: null, obstacle: null },
];

describe("stageRegex unicode boundary (F22)", () => {
  it("test_stage_regex_unicode_leading_accent", () => {
    expect(stageRegex(PLACES, ["Émile"])("Émile sat in the armchair")).toEqual({ who: "Émile", place: "armchair" });
  });
});
