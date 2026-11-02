import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

// Н11: the `look` of a `stage` beat reaches the speaker's gaze on the following `line`
// (not the nearest actor, not nothing).
const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [8, 8], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] },
  { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [2, 2], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] },
  { name: "stool", id: "stool", kind: "sit", room: "room", level: null, at: [2.5, 2], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] },
];

async function runtime() {
  const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Mama: "chair", Papa: "stool" } },
    places, cast: { Mama: { glb: "missing.glb", height_m: 1.7 }, Papa: { glb: "missing.glb", height_m: 1.8 } },
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
}
const step = (s: Awaited<ReturnType<typeof runtime>>, n = 30) => { for (let i = 0; i < n; i++) s.update(1 / 60, i / 60); };

describe("stage look -> line gaze chain", () => {
  it("stage beat with look: the following line's speaker gazes at that place, not the nearest actor", async () => {
    const s = await runtime();
    step(s);
    s.handlers.stage!({ type: "stage", who: "Mama", action: "stay", look: "bed" });
    s.handlers.line!({ type: "line", who: "Mama", text: "hello", dur: 3 });
    const g = s.api.gaze("Mama")!;
    expect(g).not.toBeNull();
    expect(g[0]).toBeCloseTo(8, 3);
    expect(g[2]).toBeCloseTo(8, 3);
  });

  it("without a stage look the speaker falls back to the nearest actor", async () => {
    const s = await runtime();
    step(s);
    s.handlers.line!({ type: "line", who: "Mama", text: "hello", dur: 3 });
    const g = s.api.gaze("Mama")!;
    const papa = s.api.actors().find((a) => a.who === "Papa")!;
    expect(Math.hypot(g[0] - papa.pos[0], g[2] - papa.pos[1])).toBeLessThan(0.01);
  });

  it("the stage look is consumed by one line; another speaker's stage look is not borrowed", async () => {
    const s = await runtime();
    step(s);
    s.handlers.stage!({ type: "stage", who: "Papa", action: "stay", look: "bed" });
    s.handlers.line!({ type: "line", who: "Mama", text: "hi", dur: 3 });
    const gm = s.api.gaze("Mama")!;
    const papa = s.api.actors().find((a) => a.who === "Papa")!;
    expect(Math.hypot(gm[0] - papa.pos[0], gm[2] - papa.pos[1])).toBeLessThan(0.01);
    s.handlers.line!({ type: "line", who: "Papa", text: "yo", dur: 3 });
    expect(s.api.gaze("Papa")![0]).toBeCloseTo(8, 3);
    s.handlers.line!({ type: "line", who: "Papa", text: "again", dur: 3 });
    const gp = s.api.gaze("Papa")!;
    const mama = s.api.actors().find((a) => a.who === "Mama")!;
    expect(Math.hypot(gp[0] - mama.pos[0], gp[2] - mama.pos[1])).toBeLessThan(0.01);
  });
});
