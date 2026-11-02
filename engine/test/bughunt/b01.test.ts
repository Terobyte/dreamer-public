import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../../src/runtime/stage/index.js";

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [5, 8], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] },
  { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [6, 5], yaw: 180, look: null, obstacle: null, poses: ["sit", "stand"] },
  { name: "door", id: "door", kind: "door", room: "room", level: null, at: [4, 5], yaw: 90, look: null, obstacle: null, poses: ["door", "stand"] },
];

describe("B01: goto after exit cancels the exit", () => {
  it("actor interrupted on the way to the door stays onstage at the new place", async () => {
    const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
    const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
    const stage = await startStage({
      scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
      stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
      places, cast: { Mama: { glb: "missing.glb", height_m: 1.7 } },
      geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
      layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
    } as any);
    const mama = () => stage.api.actors().find((a) => a.who === "Mama")! as any;
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair" });
    for (let i = 0; i < 60; i++) stage.update(1 / 60, i / 60);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "exit" });
    for (let i = 0; i < 10; i++) stage.update(1 / 60, i / 60);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "goto", place: "bed" });
    for (let i = 0; i < 60 * 12; i++) stage.update(1 / 60, i / 60);
    expect(mama().offstage).toBe(false);
    expect(mama().pos[0]).toBeCloseTo(5, 0);
    expect(mama().pos[1]).toBeCloseTo(8, 0);
  });
});
