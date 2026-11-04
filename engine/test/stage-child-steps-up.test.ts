/** Koshakan bathroom ("она должна стоять на стуле лицом к умывальнику", "мирай просто маленькая а движок думает что они
 *  оба взрослые"): the sink's stand spot is an adult's, 0.8 m off the basin, the step stool between; Mirai (0.95 m)
 *  stood behind the stool and could not reach the water. A thing too high for the actor, with a step in front of it:
 *  she stands on the step, facing the thing. An adult keeps the place's own spot. Places from the bathroom's places.json. */
import { describe, it, expect } from "vitest";
import { startSpot, yawTo, type Place } from "../src/runtime/stage/places.js";

const sink = { name: "sink", id: "sink", kind: "stand", room: "bathroom", level: "L0", at: [1.86, 2.22], yaw: 270, look: [2.88, 2.3], size: { w: 0.6, d: 0.48, h: 1.0 }, obstacle: [2.64, 2.0, 3.12, 2.6], poses: ["stand_at"] } as unknown as Place;
const stool = { name: "stool", id: "stool", kind: "sit", room: "bathroom", level: "L0", at: [2.34, 1.78], yaw: 0, look: null, size: { w: 0.45, d: 0.32, h: 0.36 }, obstacle: [2.125, 2.04, 2.575, 2.36], poses: ["stand_on", "sit"], top: 0.3519, stand_on: { at: [2.35, 2.2] } } as unknown as Place;
const tub = { name: "tub", id: "tub", kind: "stand", room: "bathroom", level: "L0", at: [1.35, 2.025], yaw: 180, look: [1.35, 2.85], size: { w: 1.6, d: 0.75, h: 1.0 }, obstacle: [0.55, 2.475, 2.15, 3.225], poses: ["stand_at"] } as unknown as Place;
const places = [tub, sink, stool];

describe("a child steps up to a thing too high for her", () => {
  it("Mirai (0.95 m) at the sink stands on the stool, on its top, facing the sink", () => {
    const s = startSpot(sink, "stand_at", sink.at, places, 0.95);
    expect(s.at).toEqual([2.35, 2.2]);
    expect(s.y).toBeCloseTo(0.3519, 4);
    expect(s.yaw).toBeCloseTo(yawTo([2.35, 2.2], [2.88, 2.3]), 6);
  });
  it("Mama (1.65 m) at the sink keeps the sink's own spot", () => {
    const s = startSpot(sink, "stand_at", sink.at, places, 1.65);
    expect(s.at).toEqual(sink.at);
    expect(s.y).toBe(0);
  });
  it("no step by the thing: the child keeps the place's spot", () => {
    const s = startSpot(tub, "stand_at", tub.at, places, 0.95);
    expect(s.at).toEqual(tub.at);
  });
});
