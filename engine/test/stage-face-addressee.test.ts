import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

// Squidward, Nov 3 ("общается со сквидом спиной"): SpongeBob stood at the easel looking at the picture and said
// "It's beautiful, Squidward" with `look: Squidward`. The gaze only turns the head, 60 deg at most, so the body
// kept its back to Squidward. A standing speaker who names whom he talks to turns his body to him.
const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "window", id: "window", kind: "stand", room: "room", level: null, at: [3, 5], yaw: 0, look: [3, 60], obstacle: null, poses: ["stand_at"] },
  { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [3, 5], yaw: 0, look: null, obstacle: null, poses: ["sit"] },
  { name: "corner", id: "corner", kind: "stand", room: "room", level: null, at: [3, 2], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
  { name: "front", id: "front", kind: "stand", room: "room", level: null, at: [3.5, 8], yaw: 180, look: null, obstacle: null, poses: ["stand_at"] },
  { name: "spot", id: "spot", kind: "stand", room: "room", level: null, at: [6, 5], yaw: 270, look: null, obstacle: null, poses: ["stand_at"] },
];

async function runtime(start: Record<string, string>) {
  const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start },
    places, cast: { Sponge: { glb: "missing.glb", height_m: 1.2 }, Squid: { glb: "missing.glb", height_m: 1.8 } },
    geo: { spawn: { at: [5, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
}
let clock = 0;
const step = (s: Awaited<ReturnType<typeof runtime>>, n: number) => { for (let i = 0; i < n; i++) s.update(1 / 60, (clock += 1 / 60)); };
const yawOf = (s: Awaited<ReturnType<typeof runtime>>, who: string) => s.api.actors().find((a) => a.who === who)!;
const off = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

// the same day: a goto with no one to look at ended facing along the last step (SpongeBob at the easel faced the wall,
// not the picture); a place that has its thing (`look`) or a yaw ends facing it, "along" is for a place without one
describe("a speaker turns his body to whom he talks to", () => {
  it("standing with his back to the listener, a line with look turns him to face the listener", async () => {
    clock = 0;
    const s = await runtime({ Sponge: "corner", Squid: "spot" });
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "window", pose: "stand_at" });
    step(s, 180);
    expect(off(yawOf(s, "Sponge").yaw, 0)).toBeLessThan(5);  // at the window, looking out (+z); Squid is at +x
    const before = yawOf(s, "Sponge").pos;
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "stay", look: "Squid" });
    s.handlers.line!({ type: "line", who: "Sponge", text: "It's beautiful, Squid.", dur: 3 });
    step(s, 60);
    expect(off(yawOf(s, "Sponge").yaw, 90)).toBeLessThan(10);
    expect(yawOf(s, "Sponge").pos).toEqual(before);  // turns on the spot, does not walk off it
  });

  // "а где модуль, что NPC смотрят друг на друга, когда говорят": Squidward's lines name no one, he spoke to the
  // canvas. Two in the room: a line that names no one is said to the other one.
  it("two in the room, a line that names no one: the speaker turns to the other", async () => {
    clock = 0;
    const s = await runtime({ Sponge: "corner", Squid: "spot" });
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "window", pose: "stand_at" });
    step(s, 180);
    s.handlers.line!({ type: "line", who: "Sponge", text: "Hi.", dur: 3 });
    step(s, 60);
    expect(off(yawOf(s, "Sponge").yaw, 90)).toBeLessThan(10);
  });

  it("a line that names a place, not a person, keeps the body as it is", async () => {
    clock = 0;
    const s = await runtime({ Sponge: "corner", Squid: "spot" });
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "window", pose: "stand_at" });
    step(s, 180);
    s.handlers.line!({ type: "line", who: "Sponge", text: "What a view.", dur: 3, look: "window" });
    step(s, 60);
    expect(off(yawOf(s, "Sponge").yaw, 0)).toBeLessThan(5);
  });

  // v8 ("на кресле он не смотрит на сквидварда"): seated, Squidward 106 deg off the chair; the head alone (60 deg)
  // looked past him. Seated, the body turns on the seat (60 deg off the seat's yaw at most), the head does the rest;
  // what the head reaches alone keeps the body as it is.
  it("a seated speaker whose listener the head cannot reach turns on the seat, no more than 60 deg", async () => {
    clock = 0;
    const s = await runtime({ Sponge: "corner", Squid: "spot" });
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "chair", pose: "sit" });
    step(s, 180);
    expect(yawOf(s, "Sponge").act).toBe("sit");
    const before = yawOf(s, "Sponge").pos;
    s.handlers.line!({ type: "line", who: "Sponge", text: "Play it again!", dur: 3, look: "Squid" });
    step(s, 60);
    // Squid at 90 deg: the body turns so the rest (<= 45 deg) is the head's
    const y = yawOf(s, "Sponge").yaw;
    expect(off(y, 90)).toBeLessThanOrEqual(46);
    expect(off(y, 0)).toBeLessThanOrEqual(61);
    expect(yawOf(s, "Sponge").act).toBe("sit");
    expect(yawOf(s, "Sponge").pos).toEqual(before);
    // a second line does not turn him further than 60 deg off the seat
    s.handlers.line!({ type: "line", who: "Sponge", text: "Again!", dur: 3, look: "Squid" });
    step(s, 60);
    expect(off(yawOf(s, "Sponge").yaw, 0)).toBeLessThanOrEqual(61);
  });

  it("seated, a listener the head reaches: the body keeps the seat's yaw", async () => {
    clock = 0;
    const s = await runtime({ Sponge: "corner", Squid: "corner" });
    s.handlers.stage!({ type: "stage", who: "Squid", action: "goto", place: "front", pose: "stand_at" });
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "chair", pose: "sit" });
    step(s, 180);
    s.handlers.line!({ type: "line", who: "Sponge", text: "Hi.", dur: 3, look: "Squid" });
    step(s, 60);
    expect(off(yawOf(s, "Sponge").yaw, 0)).toBeLessThan(5);
  });
});
