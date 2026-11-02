import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../../src/runtime/stage/index.js";

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const chair = { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [7, 5], yaw: 180, look: null, obstacle: null, poses: ["sit", "stand"] };
const door = { name: "door", id: "door", kind: "door", room: "room", level: null, at: [2, 5], yaw: 90, look: null, obstacle: null, poses: ["door", "stand"] };

async function runtime() {
  vi.stubGlobal("fetch", async () => ({ ok: false, status: 404, statusText: "offline" }));
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    places: [chair, door], cast: { Mama: { glb: "missing.glb", height_m: 1.7 } },
    geo: { spawn: { at: [6, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits: new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255) }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
}

const advance = (stage: Awaited<ReturnType<typeof runtime>>, frames: number) => {
  for (let i = 0; i < frames; i++) stage.update(1 / 60, i / 60);
};

describe("B63: narrator remark cancels an active exit", () => {
  it("without a movement remark, the actor stays onstage", async () => {
    const stage = await runtime();
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair" } as any);
    stage.handlers.narrator!({ type: "narrator", text: "The room is quiet." } as any);
    advance(stage, 2);
    expect((stage.api.actors()[0] as any).offstage).toBe(false);
  });

  it("a movement remark after exit leaves the actor at the named place onstage", async () => {
    const stage = await runtime();
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair" } as any);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "exit" } as any);
    stage.handlers.narrator!({ type: "narrator", text: "Mama went to the chair." } as any);
    advance(stage, 60 * 20);
    expect((stage.api.actors()[0] as any).offstage).toBe(false);
  });
});

afterEach(() => vi.unstubAllGlobals());
