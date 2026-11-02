import { describe, it, expect } from "vitest";
import { clipForBeat } from "../src/runtime/stage/anim.js";

const cast = {
  Mama: { clips: { shrug: "m/s0.glb", shrug_1: "m/s1.glb", shrug_2: "m/s2.glb", wave: "m/w.glb" } },
  Bare: { clips: { other: "b/o.glb" } },
};

describe("gesture table (Н17)", () => {
  it("same seed -> same clip, many calls", () => {
    const beat = { who: "Mama", text: "She was tired.", remarks: "sigh", seed: "s7" };
    const first = clipForBeat(beat, cast);
    for (let i = 0; i < 20; i++) expect(clipForBeat({ ...beat }, cast)).toEqual(first);
    expect(first?.clip).toMatch(/^shrug/);
    expect(first?.procedural).toBeUndefined();
  });
  it("seeds spread over variants", () => {
    const picks = new Set<string>();
    for (let i = 0; i < 40; i++) picks.add(clipForBeat({ who: "Mama", text: "tired", seed: `k${i}` }, cast)!.clip);
    expect(picks.size).toBeGreaterThan(1);
  });
  it("lying -> procedural verb, no clip file, no throw", () => {
    for (const pose of ["lie", "sit", "stand_on"]) {
      const r = clipForBeat({ who: "Mama", text: "tired", pose, seed: "x" }, cast);
      expect(r).toEqual({ who: "Mama", clip: "shrug", procedural: true });
    }
  });
  it("verb without a clip in the bank -> procedural", () => {
    expect(clipForBeat({ who: "Bare", text: "hello there", seed: "x" }, cast)).toEqual({ who: "Bare", clip: "wave", procedural: true });
  });
  it("remarks as array or garbage do not throw", () => {
    expect(() => clipForBeat({ who: "Mama", text: "", remarks: [1, null, "gasp"] as unknown }, cast)).not.toThrow();
    expect(() => clipForBeat({ who: "Mama", text: 5 as unknown, remarks: {} as unknown, pose: 3 as unknown }, cast)).not.toThrow();
  });
});
