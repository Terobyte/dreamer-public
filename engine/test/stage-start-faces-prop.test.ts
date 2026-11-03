/** Squidward, Nov 3: the film opened with him at his easel, his back to the canvas: the start took the easel's own
 *  yaw (it faces the room), a walk to the same place faces the easel (`place.look`). One rule for both. */
import { describe, it, expect } from "vitest";
import { startSpot } from "../src/runtime/stage/places.js";

const easel: any = { name: "easel", id: "easel", kind: "stand", room: "r", level: null, at: [0.73, 2.0], yaw: 200, look: [1.03, 2.82], poses: ["stand_at"] };

describe("a start at a stand place faces the thing, as a walk there does", () => {
  it("faces the easel, not along it", () => {
    const s = startSpot(easel, "stand_at");
    const want = (Math.atan2(1.03 - 0.73, 2.82 - 2.0) * 180) / Math.PI;
    expect(s.yaw).toBeCloseTo((want + 360) % 360, 3);
  });
  it("a place with no look keeps its own yaw", () => {
    expect(startSpot({ ...easel, look: null }, "stand_at").yaw).toBe(200);
  });
  it("a seat keeps its own yaw (one sits facing out of the chair)", () => {
    expect(startSpot({ ...easel, kind: "sit", poses: ["sit"] }, undefined).yaw).toBe(200);
  });
});
