/** Koshakan bathroom, f1: Mirai catches water at the sink (staged clip catch_water) while Mama speaks from the tub.
 *  Her body faced the sink, the gaze turned her head up to 60 deg to Mama on top of a clip that moves the head
 *  itself: the face swung 104..173 deg and the scene looked jerky. An actor busy at a thing (a staged clip at a
 *  place with a `look`) looks at the thing, not at whoever speaks. */
import { describe, it, expect } from "vitest";
import { resolveGaze, busyGazePoint, type GazeActor } from "../src/runtime/stage/index.js";
import type { Place } from "../src/runtime/stage/places.js";

const pp = (p: Place): [number, number, number] => [p.at[0], 1.4, p.at[1]];
const mama: GazeActor = { who: "Mama", room: "bath", pos: [0, 0], eye: [0, 1.55, 0] };
const sinkPt: [number, number, number] = [2.35, 0.85, 2.9];

describe("an actor busy at a thing looks at the thing", () => {
  it("Mama speaks, Mirai at the sink looks at the sink, not at Mama", () => {
    const mirai: GazeActor = { who: "Mirai", room: "bath", pos: [2.35, 2.2], eye: [2.35, 1.2, 2.2], busy: sinkPt };
    expect(resolveGaze({ speaker: "Mama", at: "Mirai", place: null, until: 10 }, 0, mirai, [mama, mirai], pp)).toEqual(sinkPt);
  });

  it("a narration does not turn her from the sink either", () => {
    const mirai: GazeActor = { who: "Mirai", room: "bath", pos: [2.35, 2.2], eye: [2.35, 1.2, 2.2], busy: sinkPt };
    expect(resolveGaze({ speaker: null, at: null, place: null, until: 10 }, 0, mirai, [mama, mirai], pp)).toEqual(sinkPt);
  });

  it("not busy -> the listener still looks at the speaker", () => {
    const mirai: GazeActor = { who: "Mirai", room: "bath", pos: [2.35, 2.2], eye: [2.35, 1.2, 2.2] };
    expect(resolveGaze({ speaker: "Mama", at: "Mirai", place: null, until: 10 }, 0, mirai, [mama, mirai], pp)).toEqual(mama.eye);
  });

  it("the thing's point: its look at its working height over the floor", () => {
    const sink = { name: "sink", id: "sink", kind: "stand", at: [2.35, 2.0], yaw: 0, look: [2.35, 2.9], size: { w: 0.6, d: 0.5, h: 0.85 } } as unknown as Place;
    expect(busyGazePoint(sink, 0)).toEqual([2.35, 0.85, 2.9]);
    expect(busyGazePoint({ ...sink, look: null } as Place, 0)).toBeNull();
  });
});
