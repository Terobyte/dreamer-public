import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const room: DRoom = { outline: [[0, 0], [10, 0], [10, 10], [0, 10]], ceiling: 3, open: false };
const cat: DActor = { name: "Cat", pos: [5, 5], yaw: 0, height: 1.5, level: null, room: null, walking: false };
const dog: DActor = { name: "Dog", pos: [7, 5], yaw: 90, height: 0.6, level: null, room: null, walking: false };

describe("director explicit shot: one source (Н7б)", () => {
  it("single actor: every bank shot on a line stays as is (pins current behaviour)", () => {
    for (const shot of ["orbit", "dolly", "ots", "two", "low", "close", "wide", "follow"] as const) {
      const out = createDirector(() => 0.5).step({ event: { kind: "line", speaker: "Cat", shot, dt: 0 }, actors: [cat], room });
      expect(out.plan).toBe(shot);
    }
  });
  it("single actor without shot is never ots/two/orbit/dolly/low", () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const out = createDirector(() => r).step({ event: { kind: "line", speaker: "Cat", dt: 0 }, actors: [cat], room });
      expect(["wide", "close", "follow"]).toContain(out.plan);
    }
  });
  it("explicit flag does not leak to the next line without shot", () => {
    const d = createDirector(() => 0.5);
    expect(d.step({ event: { kind: "line", speaker: "Cat", shot: "orbit", dt: 0 }, actors: [cat], room }).plan).toBe("orbit");
    const next = d.step({ event: { kind: "line", speaker: "Cat", dt: 0 }, actors: [cat], room });
    expect(["wide", "close", "follow"]).toContain(next.plan);
  });
  it("two actors: explicit ots kept; unknown shot name is not explicit", () => {
    const out = createDirector(() => 0.5).step({ event: { kind: "line", speaker: "Cat", shot: "ots", dt: 0 }, actors: [cat, dog], room });
    expect(out.plan).toBe("ots");
    const bad = createDirector(() => 0.5).step({ event: { kind: "line", speaker: "Cat", shot: "nonsense" as never, dt: 0 }, actors: [cat], room });
    expect(["wide", "close", "follow"]).toContain(bad.plan);
  });
});
