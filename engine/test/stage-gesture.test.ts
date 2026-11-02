import { describe, it, expect } from "vitest";
import { clipForBeat } from "../src/runtime/stage/anim.js";

const cast = {
  Mama: { clips: { shrug: "m/shrug.glb", wave: "m/wave.glb", jump: "m/jump.glb", jump2: "m/jump2.glb", hug: "m/hug.glb" } },
  Bare: { clips: {} },
};

describe("gesture from voice remarks and text", () => {
  it("remark 'sighs' without gesture -> shrug", () => {
    expect(clipForBeat({ who: "Mama", text: "Well.", remarks: "sighs" }, cast)).toEqual({ who: "Mama", clip: "shrug" });
  });
  it("remarks as a list (the sim sends lists) -> shrug", () => {
    expect(clipForBeat({ who: "Mama", text: "Well.", remarks: ["sighs"] }, cast)).toEqual({ who: "Mama", clip: "shrug" });
  });
  it("explicit gesture beats the remark", () => {
    expect(clipForBeat({ who: "Mama", text: "Well.", gesture: "hug", remarks: "sighs" }, cast)).toEqual({ who: "Mama", clip: "hug" });
  });
  it("'hello' in the text -> wave", () => {
    expect(clipForBeat({ who: "Mama", text: "Hello, you!" }, cast)).toEqual({ who: "Mama", clip: "wave" });
  });
  it("first row of the table wins on several signals", () => {
    expect(clipForBeat({ who: "Mama", text: "Hello!", remarks: "sighs, tired" }, cast)).toEqual({ who: "Mama", clip: "wave" });
  });
  it("no match -> no gesture", () => {
    expect(clipForBeat({ who: "Mama", text: "Well.", remarks: "flatly" }, cast)).toBeNull();
  });
  it("empty bank -> no gesture even on a matching remark, life nods stay", () => {
    expect(clipForBeat({ who: "Bare", text: "Well.", remarks: "sighs" }, cast)).toBeNull();
  });
  it("verb missing from the bank -> procedural gesture, no throw", () => {
    expect(clipForBeat({ who: "Mama", text: "Well.", remarks: "gasps" }, cast)).toEqual({ who: "Mama", clip: "react", procedural: true });
  });
  it("lying -> procedural gesture even when the bank has the clip", () => {
    expect(clipForBeat({ who: "Mama", text: "Well.", remarks: "sighs", pose: "lie" }, cast)).toEqual({ who: "Mama", clip: "shrug", procedural: true });
  });
  it("stand_at counts as standing: the bank clip plays, not procedural", () => {
    expect(clipForBeat({ who: "Mama", text: "Well.", remarks: "sighs", pose: "stand_at" }, cast)).toEqual({ who: "Mama", clip: "shrug" });
  });
  it("same seed -> same variant", () => {
    const b = { who: "Mama", text: "Yay", remarks: "excited", seed: "scene-1" };
    const a1 = clipForBeat(b, cast);
    expect(clipForBeat(b, cast)).toEqual(a1);
    expect(["jump", "jump2"]).toContain(a1!.clip);
    const seen = new Set(Array.from({ length: 30 }, (_, i) => clipForBeat({ ...b, seed: "s" + i }, cast)!.clip));
    expect(seen.size).toBe(2);
  });
  it("the table is shared: another character maps the same remark the same way", () => {
    const cast2 = { Papa: { clips: { shrug: "p/shrug.glb" } } };
    expect(clipForBeat({ who: "Papa", text: "Well.", remarks: "sighs" }, cast2)).toEqual({ who: "Papa", clip: "shrug" });
  });
});
