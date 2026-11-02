import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../../src/runtime/stage/index.js";

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const bed = { name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [2, 2], yaw: 0, look: null, obstacle: null, poses: ["lie"], top: 1.6, lie: { at: [2, 2], yaw: 0, head: [2, 2.5] } };
const chair = { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [3, 3], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] };
const kitchen = { name: "kitchen", id: "kitchen", kind: "stand", room: "room", level: null, at: [8, 8], yaw: 0, look: null, obstacle: null, poses: ["stand"] };

async function runtime() {
  vi.stubGlobal("fetch", async () => ({ ok: false, status: 404, statusText: "offline" }));
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  const stage = await startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    places: [bed, chair, kitchen], cast: { Mama: { glb: "missing.glb", height_m: 1.7 } },
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits: new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255) }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  return stage;
}

describe("B66: start clears a ramp-queued touch", () => {
  it("a start without an older queued touch keeps the actor sitting at the chair (control)", async () => {
    const stage = await runtime();
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair", pose: "sit" } as any);
    for (let i = 0; i < 120; i++) stage.update(1 / 60, i / 60);
    expect(stage.api.actors()[0]!.pos).toEqual([3, 3]);
  });

  it("a ramp-queued touch does not pull the actor away from a later start", async () => {
    const stage = await runtime();
    // A lie pose puts feet at top - 0.1 m = 1.5 m; only L0 exists, so this is mid-ramp.
    stage.handlers.start!({ type: "start", who: "Mama", place: "bed", pose: "lie" } as any);
    stage.handlers.touch!({ type: "touch", who: "Mama", object: "kitchen" } as any);
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair", pose: "sit" } as any);
    for (let i = 0; i < 120; i++) stage.update(1 / 60, i / 60);
    expect(stage.api.actors()[0]!.act).toBe("sit");
    expect(stage.api.actors()[0]!.pos).toEqual([3, 3]);
  });
});

afterEach(() => vi.unstubAllGlobals());
