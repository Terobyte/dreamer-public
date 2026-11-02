import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../../src/runtime/stage/index.js";

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [6, 5], yaw: 180, look: null, obstacle: null, poses: ["sit", "stand"] },
  // door without yaw (places.json entry that lacks it)
  { name: "door", id: "door", kind: "door", room: "room", level: null, at: [4, 5], look: null, obstacle: null, poses: ["door", "stand"] },
];

describe("B04: enter through a door with undefined yaw", () => {
  it("actor coordinates stay finite", async () => {
    const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
    const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
    const stage = await startStage({
      scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
      stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
      places, cast: { Mama: { glb: "missing.glb", height_m: 1.7 } },
      geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
      layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
    } as any);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "enter", place: "door" });
    for (let i = 0; i < 120; i++) stage.update(1 / 60, i / 60);
    const m = stage.api.actors().find((a) => a.who === "Mama")!;
    expect([m.pos[0], m.pos[1], m.yaw].every(Number.isFinite)).toBe(true);
  });
});
