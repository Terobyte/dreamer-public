/** Koshakan meadow, Nov 3: Spark staged every beat "stay" and the text words fired no clip (the cast verbs are phrases,
 *  "ran" is in no list): nobody ran, fell or climbed into a lap. The director now names the clip and the actor to go to. */
import { describe, it, expect } from "vitest";
import { fitStaged, stagedClips } from "../src/runtime/stage/anim.js";
import { approachGap, nearActor } from "../src/runtime/stage/places.js";

describe("the clip the director names", () => {
  const clips = ["run_joy", "lap_cloud", "stand_idle"];
  it("keeps a clip and an idle of this actor", () => {
    expect(stagedClips({ clip: "run_joy", idle: "stand_idle" }, clips)).toEqual({ clip: "run_joy", idle: "stand_idle" });
  });
  it("drops a name the actor has no clip for", () => {
    expect(stagedClips({ clip: "sit_down_grass", idle: 3 }, clips)).toEqual({});
  });
  it("matches regardless of case", () => {
    expect(stagedClips({ clip: "Run_Joy" }, clips)).toEqual({ clip: "run_joy" });
  });
});

describe("walking up to another actor", () => {
  it("stops `gap` short of the actor, on the walker's side", () => {
    const p = nearActor([0, 0], [2, 0], 0.5);
    expect(p[0]).toBeCloseTo(1.5, 6);
    expect(p[1]).toBeCloseTo(0, 6);
  });
  it("standing on the same spot still gets a point `gap` away", () => {
    const p = nearActor([1, 1], [1, 1], 0.4);
    expect(Math.hypot(p[0] - 1, p[1] - 1)).toBeCloseTo(0.4, 6);
  });
});

describe("a staged clip fits the pose (as a picked one does)", () => {
  const facts = { sleep_curled: { lying: true }, bend_whisper: { lying: false }, idle_warm: { lying: false } };
  it("standing: everything plays", () => {
    expect(fitStaged({ clip: "bend_whisper", idle: "idle_warm" }, "stand", facts)).toEqual({ clip: "bend_whisper", idle: "idle_warm" });
  });
  it("seated on the bed edge: a standing clip turns into the procedural nod (Nov 2: hunched Mama)", () => {
    expect(fitStaged({ clip: "bend_whisper", idle: "idle_warm" }, "sit", facts)).toEqual({ idle: "idle_warm", procedural: true });
  });
  it("standing: a clip measured lying is not played (Squidward v19 158 s: SpongeBob's happy_walk, lying: true, tipped him over at the table)", () => {
    expect(fitStaged({ clip: "sleep_curled", idle: "idle_warm" }, "stand_at", facts)).toEqual({ idle: "idle_warm", procedural: true });
    expect(fitStaged({ clip: "bend_whisper", idle: "sleep_curled" }, undefined, facts)).toEqual({ clip: "bend_whisper" });
  });
  it("lying: a lying clip plays, a standing idle is dropped", () => {
    expect(fitStaged({ clip: "sleep_curled", idle: "idle_warm" }, "lie", facts)).toEqual({ clip: "sleep_curled" });
  });
});

describe("how close a walker comes", () => {
  it("next to someone: the two capsules touch, never overlap (bathroom, Nov 3: 74 overlap frames at 0.5 m)", () => {
    expect(approachGap(["flick_drop"], 0.3, 0.25)).toBeCloseTo(0.6, 6);
  });
  it("into a lap: close in", () => {
    expect(approachGap(["lap_cloud"], 0.3, 0.25)).toBeLessThan(0.2);
  });
});
