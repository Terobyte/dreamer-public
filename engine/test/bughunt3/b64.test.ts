import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../../src/runtime/stage/index.js";

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const bed = { name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 180, look: null, obstacle: null, poses: ["sit", "stand"] };
const shelf = { name: "shelf", id: "shelf", kind: "stand", room: "room", level: null, at: [1, 1], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] };

async function enter(doorYaw: number | undefined) {
  vi.stubGlobal("fetch", async () => ({ ok: false, status: 404, statusText: "offline" }));
  const via = { name: "door", id: "door", kind: "door", room: "room", level: null, at: [8, 8], yaw: doorYaw, look: null, obstacle: null, poses: ["door", "stand"] };
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  const stage = await startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    places: [bed, shelf, via], cast: { Mama: { glb: "missing.glb", height_m: 1.7 } },
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits: new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255) }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  stage.handlers.start!({ type: "start", who: "Mama", place: "shelf", pose: "stand_at", offstage: true } as any);
  stage.handlers.stage!({ type: "stage", who: "Mama", action: "enter", place: "bed" } as any);
  return stage;
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

describe("B64: enter a non-door place through a yaw-less room door", () => {
  it("a door with explicit yaw is used as the entrance (control)", async () => {
    const stage = await enter(90);
    expect(dist(stage.api.actors()[0]!.pos, [8, 8])).toBeLessThan(2);
  });

  it("missing door yaw uses the safe default and places the actor at the entrance", async () => {
    const stage = await enter(undefined);
    expect(dist(stage.api.actors()[0]!.pos, [8, 8])).toBeLessThan(2);
  });
});

afterEach(() => vi.unstubAllGlobals());
