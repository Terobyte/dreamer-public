import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTouch, stageRegex, type Place } from "../src/runtime/stage/places.js";

// the numbers come from h0/make/testdata/expect_touch.json, not from resolveTouch
const EXPECT = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../h0/make/testdata/expect_touch.json", import.meta.url)), "utf-8"),
);
const case_ = (n: number): any => EXPECT.cases.find((c: any) => c.n === n);

const PLACES: Place[] = [
  { name: "armchair", id: "living_armchair", kind: "sit", room: "living", level: "L0", at: [4.22, 3.26], yaw: 180, look: null, obstacle: null },
  { name: "window", id: "living_window", kind: "stand", room: "living", level: "L0", at: [2.0, 1.0], yaw: 0, look: [2.0, 0.0], obstacle: null },
  { name: "living door", id: "door1", kind: "door", room: "living", level: "L0", at: [6.4, 2.0], yaw: 270, look: [6.0, 2.0], obstacle: null },
];
const CAST = ["Jane Eyre", "Edward Rochester"];

describe("stage places: touch contract (expect_touch.json)", () => {
  it("test_stage_touch_four_cases", () => {
    const claims: Record<string, string> = {};
    const pos: Record<string, [number, number]> = { ...EXPECT.actors_start };

    // 1: Rochester sits in the free armchair
    const c1 = case_(1);
    const r1: any = resolveTouch({ places: PLACES, claims, actor: { who: c1.who, at: pos[c1.who] }, name: "armchair", clips: [] });
    expect(r1.place.name).toBe(c1.place);
    expect(Math.hypot(r1.target[0] - c1.target[0], r1.target[1] - c1.target[1])).toBeLessThanOrEqual(0.05);
    expect(Math.abs(((r1.yaw - c1.yaw + 540) % 360) - 180)).toBeLessThanOrEqual(2);
    expect(r1.act).toBe(c1.act);
    pos[c1.who] = r1.target;
    expect(claims.armchair).toBe(c1.who);

    // 2: Jane wants the same chair: 0.8 m to the side, idle, the claim stays
    const c2 = case_(2);
    const r2: any = resolveTouch({ places: PLACES, claims, actor: { who: c2.who, at: pos[c2.who] }, name: "armchair", clips: [] });
    expect(r2.place.name).toBe(c2.place);
    expect(Math.hypot(r2.target[0] - c2.target[0], r2.target[1] - c2.target[1])).toBeLessThanOrEqual(0.05);
    expect(Math.abs(((r2.yaw - c2.yaw + 540) % 360) - 180)).toBeLessThanOrEqual(2);
    expect(r2.act).toBe(c2.act);
    expect(claims.armchair).toBe(c2.holder);

    // the same one again: nothing to do
    const again: any = resolveTouch({ places: PLACES, claims, actor: { who: c1.who, at: pos[c1.who] }, name: "armchair", clips: [] });
    expect(again.skip).toBe("already_there");

    // 3: a narrator remark walks Rochester to the window (target + yaw from the file)
    const c3 = case_(3);
    const hit = stageRegex(PLACES, CAST)(c3.narrator);
    expect(hit).toEqual({ who: c3.who, place: c3.place });
    const r3: any = resolveTouch({ places: PLACES, claims, actor: { who: c3.who, at: pos[c3.who] }, name: c3.place, clips: [] });
    expect(Math.hypot(r3.target[0] - c3.target[0], r3.target[1] - c3.target[1])).toBeLessThanOrEqual(0.05);
    expect(Math.abs(((r3.yaw - c3.yaw + 540) % 360) - 180)).toBeLessThanOrEqual(2);

    // 4: no piano in the scene
    const c4 = case_(4);
    const warn = console.warn;
    let warned = 0;
    console.warn = () => void warned++;
    const r4: any = resolveTouch({ places: PLACES, claims, actor: { who: c4.who, at: pos[c4.who] }, name: "piano", clips: [] });
    console.warn = warn;
    expect(r4.skip).toBe(c4.skip);
    expect(warned).toBe(1);
  });

  it("test_stage_regex_longest_name_first", () => {
    const places: Place[] = [
      { name: "chair", id: "a", kind: "sit", room: "r", level: "L0", at: [1, 1], yaw: 0, look: null, obstacle: null },
      { name: "library armchair", id: "b", kind: "sit", room: "r", level: "L0", at: [2, 2], yaw: 0, look: null, obstacle: null },
    ];
    expect(stageRegex(places, ["Jane Eyre"])("Jane sat in the library armchair")).toEqual({ who: "Jane Eyre", place: "library armchair" });
    expect(stageRegex(places, ["Jane Eyre"])("nothing happens")).toBeNull();
  });
});
