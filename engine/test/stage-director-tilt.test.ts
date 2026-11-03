/** Squidward, Nov 3 (film 16–21 s): SpongeBob came in; the wide for him stood 2.6 m high, 2.3 m off, aimed at his head
 *  0.57 m over the floor — 41° down, the frame was the top of his head and the floor. A held frame looks down at most
 *  30°: the camera comes down (never under 1 m over the floor), if the probe still sees the look point. */
import { describe, it, expect } from "vitest";
import { capTilt } from "../src/runtime/stage/director.js";

const pitch = (cam: number[], look: number[]): number =>
  (Math.atan2(cam[1] - look[1], Math.hypot(look[0] - cam[0], look[2] - cam[2])) * 180) / Math.PI;

describe("capTilt", () => {
  it("the 41° wide on SpongeBob comes down to 30°", () => {
    const out = capTilt({ plan: "wide", cut: 1, cam: [-1.39, 2.6, 2.59], look: [-2.73, 0.57, 0.99] } as any, 0);
    expect(pitch(out.cam, out.look)).toBeLessThanOrEqual(30.5);
    expect(out.cam[0]).toBe(-1.39);
    expect(out.cam[2]).toBe(2.59);
  });
  it("never under 1 m over the floor", () => {
    const out = capTilt({ plan: "wide", cut: 1, cam: [0, 2.0, 0.6], look: [0, 0.2, 0] } as any, 0);
    expect(out.cam[1]).toBeCloseTo(1.0, 5);
  });
  it("a move (end) and a gentle frame are kept", () => {
    const mv = { plan: "wide", cut: 1, cam: [0, 3, 1], look: [0, 0, 0], end: [0, 1, 3] } as any;
    expect(capTilt(mv, 0)).toBe(mv);
    const calm = { plan: "two", cut: 1, cam: [0, 1.5, 3], look: [0, 1.0, 0] } as any;
    expect(capTilt(calm, 0)).toBe(calm);
  });
  it("a lower camera the probe does not see through keeps the frame", () => {
    const out0 = { plan: "wide", cut: 1, cam: [-1.39, 2.6, 2.59], look: [-2.73, 0.57, 0.99] } as any;
    expect(capTilt(out0, 0, () => false)).toBe(out0);
  });
  // the film again (v16, 18–25 s): straight down to 1.8 m the table hid SpongeBob; a bit higher, or further back, sees
  it("blocked at the low point: the lowest clear height, else back along the look line inside the room", () => {
    const out0 = { plan: "two", cut: 1, cam: [-1.39, 2.6, 2.59], look: [-2.73, 0.57, 0.99] } as any;
    const room = [[-4.2, -4.2], [4.2, -4.2], [4.2, 4.2], [-4.2, 4.2]] as [number, number][];
    // a table hides the look from under 2.2 m at this spot
    const spot = (c: number[]) => Math.hypot(c[0] + 1.39, c[2] - 2.59) < 0.05;
    // only this spot sees, from 2.2 m up: the lowest clear height there
    const up = capTilt(out0, 0, (c) => spot(c) && c[1] >= 2.2, [], room);
    expect(up.cam[1]).toBeGreaterThanOrEqual(2.2);
    expect(up.cam[1]).toBeLessThan(2.6);
    // nothing over the spot sees: the camera backs off along the look line, 30° at most
    const back = capTilt(out0, 0, (c) => Math.hypot(c[0] + 1.39, c[2] - 2.59) > 0.05, [], room);
    expect(pitch(back.cam, back.look)).toBeLessThanOrEqual(30.5);
    expect(Math.abs(back.cam[0]) < 4 && Math.abs(back.cam[2]) < 4).toBe(true);
  });
  // v17 77–81 s: a two-shot looks at the middle between the heads; the line to that point went through the canvas,
  // the probe said "blocked" for every lower camera. What the frame must see is the heads in it, not its look point.
  it("a two-shot comes down when the heads are seen, even if its look point between them is hidden", () => {
    const L: any = [0.35, 0.84, 2.13];
    const crew: any = [
      { name: "SpongeBob", pos: [-0.04, 2.26], head: [-0.04, 0.59, 2.26], height: 1, yaw: 0, level: null, room: "r", walking: false },
      { name: "Squidward", pos: [0.73, 2.0], head: [0.7, 1.15, 2.01], height: 1.8, yaw: 0, level: null, room: "r", walking: false },
    ];
    const out0: any = { plan: "two", cut: 1, cam: [1.1, 2.22, 3.27], look: L, fov: 50 };
    const blind = (_c: number[], l: number[]) => !(l[0] === L[0] && l[1] === L[1] && l[2] === L[2]);
    const o = capTilt(out0, 0, blind, crew);
    expect(pitch(o.cam, o.look)).toBeLessThanOrEqual(30.5);
  });
});
