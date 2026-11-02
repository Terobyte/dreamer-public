import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

// Koshakan bedroom 11-02: the director wrote `enter` with place "bed" (the bank has no door). The engine took the
// bed for a door: Mama appeared 1 m behind the bed spot, by the wall, and never reached the bed. And an actor that
// starts offstage stood visible by the bookshelf until her entrance.

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const bed = { name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 180, look: null, obstacle: null, poses: ["lie", "sit"] };
const shelf = { name: "shelf", id: "shelf", kind: "stand", room: "room", level: null, at: [2, 2], yaw: 90, look: null, obstacle: null, poses: ["stand_at"] };
const door = { name: "door", id: "door", kind: "door", room: "room", level: null, at: [8, 8], yaw: 90, look: null, obstacle: null, poses: ["door", "stand"] };

async function runtime(bank: any[]) {
  const scene = new Scene();
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  const stage = await startStage({
    scene, camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    places: bank, cast: { Mama: { glb: "missing.glb", height_m: 1.7 } },
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits: new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255) }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  return { stage, scene };
}
const run = (stage: any, seconds: number, t0 = 0) => { for (let i = 0; i < seconds * 60; i++) stage.update(1 / 60, t0 + i / 60); };
const mama = (stage: any) => stage.api.actors().find((a: any) => a.who === "Mama")!;
const group = (scene: Scene) => scene.getObjectByName("actor:Mama")!;
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

describe("offstage and enter", () => {
  it("an actor that starts offstage is not drawn; enter shows her", async () => {
    const { stage, scene } = await runtime([bed, shelf, door]);
    stage.handlers.start!({ type: "start", who: "Mama", place: "shelf", pose: "stand_at", offstage: true } as any);
    run(stage, 0.5);
    expect(group(scene).visible).toBe(false);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "enter", place: "door" } as any);
    run(stage, 0.5, 1);
    expect(group(scene).visible).toBe(true);
  });

  it("enter with a place that is not a door walks in through the room's door and ends at that place", async () => {
    const { stage } = await runtime([bed, shelf, door]);
    stage.handlers.start!({ type: "start", who: "Mama", place: "shelf", pose: "stand_at", offstage: true } as any);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "enter", place: "bed" } as any);
    // she appears at the door, not 1 m behind the bed spot
    expect(dist(mama(stage).pos, door.at)).toBeLessThan(1.5);
    run(stage, 15);
    expect(dist(mama(stage).pos, bed.at)).toBeLessThan(0.6);
    expect(mama(stage).offstage).toBe(false);
  });

  it("enter with a place that is not a door, in a room with no door: walks to the place from where she is", async () => {
    const { stage } = await runtime([bed, shelf]);
    stage.handlers.start!({ type: "start", who: "Mama", place: "shelf", pose: "stand_at", offstage: true } as any);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "enter", place: "bed" } as any);
    run(stage, 15);
    expect(dist(mama(stage).pos, bed.at)).toBeLessThan(0.6);
    expect(mama(stage).offstage).toBe(false);
  });
});
