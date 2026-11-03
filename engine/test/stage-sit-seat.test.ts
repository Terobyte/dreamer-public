import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

// Squidward, Nov 3 ("когда спанч садится он не может на стул нормально сесть"): the chair stood inside the table's
// block of the nav; its sit point was snapped to the nearest walkable cell, 0.65 m off the seat, and SpongeBob sat
// in the air beside the chair. He walks to `at` and steps onto `seat.at`.
const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [5, 4.2], yaw: 270, look: null, obstacle: [4.7, 4.6, 5.3, 5.4], poses: ["sit"], seat: { at: [4.95, 5.0] }, top: 0.5 },
  { name: "front door", id: "front", kind: "door", room: "room", level: null, at: [1, 2], yaw: 90, look: [0.2, 2], obstacle: null, poses: ["door"] },
  { name: "spot", id: "spot", kind: "stand", room: "room", level: null, at: [2, 2], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
];
async function runtime() {
  const W = 250;
  const bits = new Uint8Array(Math.ceil((W * W) / 8)).fill(255);
  // the table + chairs block: x 3.5..5.5, z 4.5..5.6 not walkable
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const x = (i + 0.5) * 0.04, z = (j + 0.5) * 0.04;
    if (x > 3.5 && x < 5.5 && z > 4.5 && z < 5.6) { const n = j * W + i; bits[n >> 3] &= ~(1 << (n & 7)); }
  }
  const layer = { level: null, y: 0, origin: [0, 0], w: W, h: W };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Sponge: "spot" } },
    places, cast: { Sponge: { glb: "missing.glb", height_m: 1.2 } },
    geo: { spawn: { at: [2, 2] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
}

describe("sit: on the seat, not beside it", () => {
  it("a chair inside the nav's blocked table: he walks to its nav cell and sits on its seat", async () => {
    const s = await runtime();
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "chair", pose: "sit" });
    let t = 0;
    for (let i = 0; i < 600; i++) s.update(1 / 60, (t += 1 / 60));
    const a = s.api.actors().find((x) => x.who === "Sponge")!;
    expect(a.act).toBe("sit");
    expect(Math.hypot(a.pos[0] - 4.95, a.pos[1] - 5.0)).toBeLessThan(0.05);
  });

  it("a goto with no pose to a seat place sits on the seat too", async () => {
    const s = await runtime();
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "chair" });
    let t = 0;
    for (let i = 0; i < 600; i++) s.update(1 / 60, (t += 1 / 60));
    const a = s.api.actors().find((x) => x.who === "Sponge")!;
    expect(a.act).toBe("sit");
    expect(Math.hypot(a.pos[0] - 4.95, a.pos[1] - 5.0)).toBeLessThan(0.05);
  });

  // the film's end, the same day: "SpongeBob jumped up, and the two walked to the front door" — `exit` from the seat
  // inside the table's block found no route (the start cell is blocked) and he stayed seated while Squidward left
  it("exit from a seat inside the blocked table: he gets up and walks out", async () => {
    const s = await runtime();
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "chair", pose: "sit" });
    let t = 0;
    for (let i = 0; i < 600; i++) s.update(1 / 60, (t += 1 / 60));
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "exit" });
    for (let i = 0; i < 1200; i++) s.update(1 / 60, (t += 1 / 60));
    const a = s.api.actors().find((x) => x.who === "Sponge")!;
    expect(a.offstage).toBe(true);
  });
});
