import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

// Koshakan bathroom, f5: Mirai on the stool catching water at the sink said "It tickles!" and the speaker turn spun
// her on the stool to Mama, her back to the sink, for the rest of the scene. Busy at a thing (a staged clip at a place
// with a `look`), a speaker keeps her body to the thing; the head may still turn (life.ts).
const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "sink", id: "sink", kind: "stand", room: "room", level: null, at: [3, 5], yaw: 0, look: [3, 6], obstacle: null, poses: ["stand_at"], size: { w: 0.6, d: 0.5, h: 0.85 } },
  { name: "corner", id: "corner", kind: "stand", room: "room", level: null, at: [3, 2], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
  { name: "spot", id: "spot", kind: "stand", room: "room", level: null, at: [6, 5], yaw: 270, look: null, obstacle: null, poses: ["stand_at"] },
];
async function runtime(start: Record<string, string>) {
  const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start },
    places, cast: { Kid: { glb: "missing.glb", height_m: 1.2, clips: { catch_water: "missing.glb" } }, Mom: { glb: "missing.glb", height_m: 1.7 } },
    geo: { spawn: { at: [5, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
}
let clock = 0;
const step = (s: Awaited<ReturnType<typeof runtime>>, n: number) => { for (let i = 0; i < n; i++) s.update(1 / 60, (clock += 1 / 60)); };
const yawOf = (s: Awaited<ReturnType<typeof runtime>>, who: string) => s.api.actors().find((a) => a.who === who)!.yaw;
const off = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

describe("a speaker busy at a thing keeps her body to it", () => {
  it("catching water at the sink, a line to Mom does not turn her from the sink", async () => {
    clock = 0;
    const s = await runtime({ Kid: "corner", Mom: "spot" });
    s.handlers.stage!({ type: "stage", who: "Kid", action: "goto", place: "sink", pose: "stand_at" });
    step(s, 420);
    s.handlers.stage!({ type: "stage", who: "Kid", action: "stay", place: "sink", pose: "stand_at", clip: "catch_water", idle: "catch_water" });
    step(s, 1);
    const atSink = yawOf(s, "Kid");
    expect(off(atSink, 90)).toBeGreaterThan(30);  // not already facing Mom
    s.handlers.line!({ type: "line", who: "Kid", text: "It tickles!", dur: 3 });
    step(s, 60);
    expect(off(yawOf(s, "Kid"), atSink)).toBeLessThan(2);
  });

  it("not busy, the same line still turns her to Mom", async () => {
    clock = 0;
    const s = await runtime({ Kid: "corner", Mom: "spot" });
    s.handlers.stage!({ type: "stage", who: "Kid", action: "goto", place: "sink", pose: "stand_at" });
    step(s, 420);
    s.handlers.line!({ type: "line", who: "Kid", text: "It tickles!", dur: 3 });
    step(s, 60);
    expect(off(yawOf(s, "Kid"), 90)).toBeLessThan(10);
  });
});
