import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [2, 2], yaw: 0, look: null, obstacle: null, poses: ["stand"] },
  { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [3, 2], yaw: 0, look: null, obstacle: null, poses: ["stand"] },
  { name: "door", id: "door", kind: "door", room: "room", level: null, at: [9, 9], yaw: 0, look: null, obstacle: null, poses: ["stand"] },
];
async function make() {
  const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  const cast: any = {};
  for (const n of ["A", "B", "C"]) cast[n] = { glb: "missing.glb", height_m: 1.7 };
  const stage = await startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    places, cast,
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  // A near B (nearest), C far away
  stage.handlers.start!({ type: "start", who: "A", place: "bed" });
  stage.handlers.start!({ type: "start", who: "B", place: "chair" });
  stage.handlers.start!({ type: "start", who: "C", place: "door" });
  for (let i = 0; i < 600; i++) stage.update(1 / 60, i / 60);
  return stage;
}
const near = (g: number[] | null, p: number[]) => !!g && Math.hypot(g[0] - p[0], g[2] - p[1]) < 1e-6;

describe("stage-beat look reaches the speaker's gaze", () => {
  it("stage look on C, line without look -> A looks at C", async () => {
    const s = await make();
    const c = s.api.actors().find((a) => a.who === "C")!;
    s.handlers.stage!({ type: "stage", who: "A", action: "stay", look: "C" });
    s.handlers.line!({ type: "line", who: "A", text: "hi", dur: 2 });
    s.update(1 / 60, 11);
    expect(near(s.api.gaze("A"), c.pos)).toBe(true);
  });
  it("line's own look beats the stage-beat look", async () => {
    const s = await make();
    const b = s.api.actors().find((a) => a.who === "B")!;
    s.handlers.stage!({ type: "stage", who: "A", action: "stay", look: "C" });
    s.handlers.line!({ type: "line", who: "A", text: "hi", dur: 2, look: "B" });
    s.update(1 / 60, 11);
    expect(near(s.api.gaze("A"), b.pos)).toBe(true);
  });
  it("look is not inherited by another speaker's line", async () => {
    const s = await make();
    const a = s.api.actors().find((x) => x.who === "A")!;
    s.handlers.stage!({ type: "stage", who: "A", action: "stay", look: "C" });
    s.handlers.line!({ type: "line", who: "B", text: "yo", dur: 2 });
    s.update(1 / 60, 11);
    expect(near(s.api.gaze("B"), a.pos)).toBe(true); // nearest = A
    s.handlers.line!({ type: "line", who: "A", text: "again", dur: 2 });
    s.handlers.line!({ type: "line", who: "B", text: "yo2", dur: 2 });
    s.update(1 / 60, 12);
    expect(near(s.api.gaze("B"), a.pos)).toBe(true);
  });
  it("stage beat without look -> nearest listener as before", async () => {
    const s = await make();
    const b = s.api.actors().find((x) => x.who === "B")!;
    s.handlers.stage!({ type: "stage", who: "A", action: "stay" });
    s.handlers.line!({ type: "line", who: "A", text: "hi", dur: 2 });
    s.update(1 / 60, 11);
    expect(near(s.api.gaze("A"), b.pos)).toBe(true);
  });
  it(" чужaя реплика не потребляет look: stage(A,C) -> line(B) -> line(A) => A смотрит на C", async () => {
    const s = await make();
    const a = s.api.actors().find((x) => x.who === "A")!;
    const c = s.api.actors().find((x) => x.who === "C")!;
    s.handlers.stage!({ type: "stage", who: "A", action: "stay", look: "C" });
    s.handlers.line!({ type: "line", who: "B", text: "yo", dur: 2 });
    s.update(1 / 60, 11);
    expect(near(s.api.gaze("B"), a.pos)).toBe(true);
    s.handlers.line!({ type: "line", who: "A", text: "again", dur: 2 });
    s.update(1 / 60, 12);
    expect(near(s.api.gaze("A"), c.pos)).toBe(true);
  });
});
