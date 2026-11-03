/** Squidward, Nov 3: the film opens on "Squidward stood at his easel and painted", the start entry had no clip and he
 *  stood still. A start entry may name the idle the actor is already doing; only that actor's own clip counts. */
import { describe, it, expect } from "vitest";
import { startStaged } from "../src/runtime/stage/anim.js";

describe("a start entry carries the idle the actor opens with", () => {
  it("an own clip is the idle", () => {
    expect(startStaged({ who: "Squidward", place: "easel", idle: "paint" }, ["idle", "paint"])).toEqual({ idle: "paint" });
  });
  it("no idle or an unknown one changes nothing", () => {
    expect(startStaged({ who: "Squidward", place: "easel" }, ["idle", "paint"])).toEqual({});
    expect(startStaged({ who: "Squidward", idle: "juggle" }, ["idle", "paint"])).toEqual({});
  });
  it("a start never plays a once-clip: only the idle is taken", () => {
    expect(startStaged({ who: "Squidward", clip: "wave", idle: "paint" }, ["wave", "paint"])).toEqual({ idle: "paint" });
  });
});
