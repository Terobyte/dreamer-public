import { describe, expect, it } from "vitest";
import { Bone, Group } from "three";
import { findLegs } from "../../src/runtime/stage/pose.js";

function knees(names: string[]): Bone[] {
  const root = new Group();
  for (const name of names) {
    const bone = new Bone();
    bone.name = name;
    root.add(bone);
  }
  return findLegs(root).knees as Bone[];
}

describe("B68: right lower-leg names keep their right side", () => {
  it("finds both lower legs; unambiguous left/right names are the passing control", () => {
    expect(knees(["leftlowerleg", "rightlowerleg"])).toHaveLength(2);
    expect(knees(["lowerleg_l", "lowerleg_r"])).toHaveLength(2);
  });
});
