/** Squidward v31 152.5–153.5 s: SpongeBob went through the pineapple door first, the camera cut in with him; the next
 *  tick went back out to Squidward, the last speaker, still on the street; he came in half a second later and it cut
 *  in again: three cuts in a second. While someone is in the camera's room, a tick keeps the camera there. */
import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

const room: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const street: Array<[number, number]> = [[12, 0], [24, 0], [24, 12], [12, 12]];
const places: any[] = [
  { name: "front door", id: "front", kind: "door", room: "room", level: null, at: [5, 9.6], yaw: 0, look: null, obstacle: null, poses: ["door"], to: "street door" },
  { name: "street door", id: "street_door", kind: "door", room: "street", level: null, at: [18, 11.6], yaw: 180, look: null, obstacle: null, poses: ["door"] },
  { name: "corner", id: "corner", kind: "stand", room: "room", level: null, at: [4.6, 7], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
  { name: "corner2", id: "corner2", kind: "stand", room: "room", level: null, at: [5.4, 4], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
];

async function runtime() {
  const W = 650, H = 650;
  const bits = new Uint8Array(Math.ceil((W * H) / 8)).fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: W, h: H };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Sponge: "corner", Squid: "corner2" } },
    places, cast: { Sponge: { glb: "missing.glb", height_m: 1.0 }, Squid: { glb: "missing.glb", height_m: 1.8 } },
    geo: { spawn: { at: [5, 5] }, floors: [{ room: "room", level: null, outline: room }, { room: "street", level: null, outline: street }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false, door: () => {},
  } as any);
}

describe("two through a door one after the other", () => {
  it("the camera goes through once, it does not go back for the one still behind", async () => {
    let clock = 0;
    const s = await runtime();
    s.handlers.line!({ type: "line", who: "Squid", text: "come on", source: "book", dur: 1 } as any);
    for (let i = 0; i < 90; i++) s.update(1 / 60, (clock += 1 / 60));
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "front door", pose: "door" });
    s.handlers.stage!({ type: "stage", who: "Squid", action: "goto", place: "front door", pose: "door" });
    const rooms: string[] = [];
    for (let i = 0; i < 1200; i++) {
      s.update(1 / 60, (clock += 1 / 60));
      const r = s.api.camera().room;
      if (r && rooms[rooms.length - 1] !== r) rooms.push(r);
    }
    const where = s.api.actors().map((a) => `${a.who}@${a.pos.map((v: number) => v.toFixed(1))}`);
    expect(where.every((w) => Number(w.split("@")[1].split(",")[0]) > 11), where.join(" ")).toBe(true);
    expect(rooms).toEqual(["room", "street"]);
  });
});
