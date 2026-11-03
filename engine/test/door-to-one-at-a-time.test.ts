/** Squidward v25 138 s and 144–149 s: both went through a door that leads elsewhere in one beat; the second came out
 *  on the same spot as the first, they walked out of the door inside each other. Who comes out of a `to` door where
 *  another still stands waits behind it, offstage, until the way is clear. */
import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

const room: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const street: Array<[number, number]> = [[12, 0], [24, 0], [24, 12], [12, 12]];
const places: any[] = [
  { name: "front door", id: "front", kind: "door", room: "room", level: null, at: [5, 9.6], yaw: 0, look: null, obstacle: null, poses: ["door"], to: "street door" },
  { name: "street door", id: "street_door", kind: "door", room: "street", level: null, at: [18, 11.6], yaw: 180, look: null, obstacle: null, poses: ["door"] },
  { name: "corner", id: "corner", kind: "stand", room: "room", level: null, at: [4.6, 8], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
  { name: "corner2", id: "corner2", kind: "stand", room: "room", level: null, at: [5.4, 8], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
  { name: "far", id: "far", kind: "stand", room: "street", level: null, at: [18, 3], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
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

describe("a door that leads elsewhere, two through it", () => {
  it("they come out one after the other, never inside each other", async () => {
    let clock = 0;
    const s = await runtime();
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "front door", pose: "door" });
    s.handlers.stage!({ type: "stage", who: "Squid", action: "goto", place: "front door", pose: "door" });
    let worst = Infinity;
    let both = 0;
    for (let i = 0; i < 900; i++) {
      s.update(1 / 60, (clock += 1 / 60));
      const [a, b] = ["Sponge", "Squid"].map((w) => s.api.actors().find((x) => x.who === w)!);
      if (a.offstage || b.offstage || a.pos[0] < 11 || b.pos[0] < 11) continue;
      both++;
      worst = Math.min(worst, Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]));
    }
    expect(both).toBeGreaterThan(0);
    expect(worst).toBeGreaterThan(0.4);
  });

  it("on the way to the door, inside, the one behind keeps off the one ahead", async () => {
    let clock = 0;
    const s = await runtime();
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "front door", pose: "door" });
    s.handlers.stage!({ type: "stage", who: "Squid", action: "goto", place: "front door", pose: "door" });
    let worst = Infinity;
    for (let i = 0; i < 600; i++) {
      s.update(1 / 60, (clock += 1 / 60));
      const [a, b] = ["Sponge", "Squid"].map((w) => s.api.actors().find((x) => x.who === w)!);
      if (a.offstage || b.offstage || a.pos[0] > 11 || b.pos[0] > 11) continue;
      worst = Math.min(worst, Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]));
    }
    // a guard: side by side at the doorway they come to 0.38 m today
    expect(worst).toBeGreaterThan(0.35);
  });
});
