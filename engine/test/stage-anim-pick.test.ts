import { describe, it, expect } from "vitest";
import { aliasesOf, clipForBeat, pickClip } from "../src/runtime/stage/anim.js";

const cast = {
  Mama: { clips: { wake: "m/wake.glb", flick: "m/flick.glb", hug: "m/hug.glb", pat: "m/pat.glb" }, verbs: { pat: ["tap"] } },
  Mirai: { clips: { leap: "r/leap.glb", hug: "r/hug.glb", flick: "r/flick.glb" } },
  Bare: { clips: {} },
  Émile: { clips: { wake: "e/wake.glb" } },
};

describe("pickClip", () => {
  it("picks subject + verb", () => {
    expect(pickClip("Mama flicked one tiny drop onto her cheek", null, cast)).toEqual({ who: "Mama", clip: "flick" });
    expect(pickClip("Mirai ran, and ran, and jumped", null, cast)).toEqual({ who: "Mirai", clip: "leap" });
  });
  it("subject, not object", () => {
    expect(pickClip("Mirai hugged Mama tight", null, cast)).toEqual({ who: "Mirai", clip: "hug" });
    expect(pickClip("Mama hugged Mirai and Mirai ran", null, cast)).toEqual({ who: "Mama", clip: "hug" });
  });
  it("aliases; nearest before the verb; name beats alias", () => {
    expect(pickClip("mum woke", null, cast, { mum: "Mama" })).toEqual({ who: "Mama", clip: "wake" });
    expect(pickClip("Mama and nan hugged", null, cast, { nan: "Mirai" })).toEqual({ who: "Mirai", clip: "hug" });
    expect(pickClip("mirai hugged", null, cast, { mirai: "Mama" })).toEqual({ who: "Mirai", clip: "hug" });
  });
  it("no verb -> null; speaker fills the subject in a line; narrator needs a name", () => {
    expect(pickClip("Hello there, Mama", "Mama", cast)).toBeNull();
    expect(pickClip("I woke up", "Mama", cast)).toEqual({ who: "Mama", clip: "wake" });
    expect(pickClip("She woke", null, cast)).toBeNull();
  });
  it("character without that clip -> null", () => {
    expect(pickClip("Bare woke", null, cast)).toBeNull();
    expect(pickClip("Mirai woke", null, cast)).toBeNull();
  });
  it("cast verbs extend the dictionary", () => {
    expect(pickClip("Mama tapped", null, cast)).toBeNull();
    expect(pickClip("Mama tap", null, cast)).toEqual({ who: "Mama", clip: "pat" });
  });
  it("unicode and possessive boundaries", () => {
    expect(pickClip("Émile woke", null, cast)).toEqual({ who: "Émile", clip: "wake" });
    expect(pickClip("xÉmile woke", null, cast)).toBeNull();
    expect(pickClip("Mirai's hand flicked", null, cast)).toEqual({ who: "Mirai", clip: "flick" });
    expect(pickClip("Mamas woke", null, cast)).toBeNull();
  });
});

describe("clipForBeat", () => {
  it("gesture beats the text", () => {
    expect(clipForBeat({ who: "Mama", text: "Mama woke", gesture: "hug" }, cast)).toEqual({ who: "Mama", clip: "hug" });
    expect(clipForBeat({ who: "Mama", text: "x", gesture: "HUG" }, cast)).toEqual({ who: "Mama", clip: "hug" });
  });
  it("gesture text goes through pickClip, then the line text", () => {
    expect(clipForBeat({ who: "Mama", text: "hi", gesture: "flicked" }, cast)).toEqual({ who: "Mama", clip: "flick" });
    expect(clipForBeat({ who: "Mama", text: "I woke", gesture: "dance" }, cast)).toEqual({ who: "Mama", clip: "wake" });
  });
  it("narrator uses text only; empty bank with a matching verb -> procedural (F3)", () => {
    expect(clipForBeat({ who: null, text: "Mama woke", gesture: "hug" }, cast)).toEqual({ who: "Mama", clip: "wake" });
    expect(clipForBeat({ who: "Bare", text: "hello" }, cast)).toEqual({ who: "Bare", clip: "wave", procedural: true });
  });
});

describe("clipForBeat lying pose review regressions", () => {
  const bank = { Mama: { clips: { jump: "m/jump.glb" }, verbs: { jump: ["jumped"] } } };

  it("F12: explicit gesture clip on a lying pose is procedural", () => {
    expect(clipForBeat({ who: "Mama", text: "Well.", gesture: "jump", pose: "lie" },
      { Mama: { clips: { jump: "m/jump.glb" } } })).toEqual({ who: "Mama", clip: "jump", procedural: true });
  });

  it("F12: text-selected clip on a lying pose is procedural", () => {
    expect(clipForBeat({ who: "Mama", text: "Mama jumped", pose: "lie" }, bank))
      .toEqual({ who: "Mama", clip: "jump", procedural: true });
  });
});

describe("aliasesOf: names in the book language", () => {
  const ru = {
    Mirai: { clips: { sleep: "r/sleep.glb" }, verbs: { sleep: ["спала"] }, aliases: ["Мирай", "Мирай "] },
    Mama: { clips: { bend: "m/bend.glb" }, verbs: { bend: ["наклонилась"] }, aliases: ["Мама"] },
    Bare: { clips: {} },
  };
  it("maps each alias to its cast member, case-folded", () => {
    expect(aliasesOf(ru)).toEqual({ "мирай": "Mirai", "мама": "Mama" });
  });
  it("a Russian narration names the actor and picks the Russian verb", () => {
    const al = aliasesOf(ru);
    expect(clipForBeat({ who: null, text: "А внутри Мирай ещё спала, свернувшись." }, ru, al)).toEqual({ who: "Mirai", clip: "sleep" });
    expect(clipForBeat({ who: null, text: "Мама наклонилась и прошептала." }, ru, al)).toEqual({ who: "Mama", clip: "bend" });
  });
  it("without aliases the same narration picks nothing (the bug)", () => {
    expect(clipForBeat({ who: null, text: "А внутри Мирай ещё спала." }, ru)).toBeNull();
  });
});

describe("narration picks respect the actor's pose (Koshakan bedroom, Nov 2)", () => {
  // "Mama bent down and whispered" fired bend_whisper, a standing clip, on Mama seated on the bed: she hunched over Mirai
  const bank = {
    Mama: { clips: { bend_whisper: "m/b.glb" }, verbs: { bend_whisper: ["bent"] } },
    Mirai: { clips: { sleep_curled: "r/s.glb" }, verbs: { sleep_curled: ["asleep"] } },
  };
  const poses: Record<string, string> = { Mama: "sit", Mirai: "lie" };
  const lyingClips = new Set(["sleep_curled"]);
  const fits = (_who: string, clip: string, pose: string): boolean => (pose === "lie" ? lyingClips.has(clip) : false);
  const poseOf = (who: string): string | undefined => poses[who];

  it("a standing clip named by narration on a seated actor becomes a procedural gesture", () => {
    expect(clipForBeat({ who: null, text: "Mama bent down and whispered." }, bank, {}, { poseOf, fits }))
      .toEqual({ who: "Mama", clip: "bend_whisper", procedural: true });
  });
  it("a lying clip on a lying actor still plays", () => {
    expect(clipForBeat({ who: null, text: "Mirai was still asleep." }, bank, {}, { poseOf, fits })).toEqual({ who: "Mirai", clip: "sleep_curled" });
  });
  it("a standing actor plays the clip as before", () => {
    expect(clipForBeat({ who: null, text: "Mama bent down and whispered." }, bank, {}, { poseOf: () => "stand", fits }))
      .toEqual({ who: "Mama", clip: "bend_whisper" });
  });
});
