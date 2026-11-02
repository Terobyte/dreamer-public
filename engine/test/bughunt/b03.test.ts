import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../../src/runtime/stage/index.js";

const roomOutline: Array<[number, number]> = [[0, 0], [8, 0], [8, 8], [0, 8]];
const hallOutline: Array<[number, number]> = [[20, 0], [28, 0], [28, 8], [20, 8]];
const places: any[] = [
  { name: "sofa", id: "sofa", kind: "sit", room: "room", level: null, at: [4, 4], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] },
  { name: "stool", id: "stool", kind: "sit", room: "hall", level: null, at: [24, 4], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] },
];

describe("B03: a line from an offstage speaker must not aim the camera at the empty room", () => {
  it("camera stays in the room of the onstage actor", async () => {
    const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
    const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    const stage = await startStage({
      scene: new Scene(), camera, stageUrl: "stage/stage.json", sim: null,
      stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Bob: "sofa", Mama: "stool" } },
      places,
      cast: { Bob: { glb: "missing.glb", height_m: 1.7 }, Mama: { glb: "missing.glb", height_m: 1.7 } },
      geo: {
        spawn: { at: [4, 4] },
        floors: [{ room: "room", level: null, outline: roomOutline }, { room: "hall", level: null, outline: hallOutline }],
        meshes: [],
      },
      layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
    } as any);
    stage.handlers.start!({ type: "start", who: "Mama", place: "stool", offstage: true });
    for (let i = 0; i < 30; i++) stage.update(1 / 60, i / 60);
    expect((stage.api.actors().find((a) => a.who === "Mama") as any).offstage).toBe(true);
    stage.handlers.line!({ type: "line", who: "Mama", text: "Я ушла!" });
    stage.update(1 / 60, 1); // the one frame that consumes the line event
    expect(stage.api.camera().room).toBe("room");
  });
});
