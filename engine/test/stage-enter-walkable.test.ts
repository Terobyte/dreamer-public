import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

// Squidward, Nov 3: with the door yaw finally pointing into the room, the 1 m step in landed SpongeBob inside the
// table's block of the nav (chairs + table, no walkable cell); from there no route existed and every later goto
// was dropped: he stood at the door the whole film. The step in ends on the farthest walkable cell (<= 1 m).
const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "door", id: "door", kind: "door", room: "room", level: null, at: [1, 5], yaw: 90, look: [0.2, 5], obstacle: null, poses: ["door"] },
  { name: "spot", id: "spot", kind: "stand", room: "room", level: null, at: [6, 3], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
  { name: "far", id: "far", kind: "stand", room: "room", level: null, at: [8, 8], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
];

async function runtime(block: [number, number, number, number] = [1.6, 4.4, 2.6, 5.6]) {
  const W = 250;
  const bits = new Uint8Array(Math.ceil((W * W) / 8)).fill(255);
  // a table block: x 1.6..2.6, z 4.4..5.6 not walkable (CELL 0.04)
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const x = (i + 0.5) * 0.04, z = (j + 0.5) * 0.04;
    if (x > block[0] && x < block[2] && z > block[1] && z < block[3]) { const n = j * W + i; bits[n >> 3] &= ~(1 << (n & 7)); }
  }
  const layer = { level: null, y: 0, origin: [0, 0], w: W, h: W };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Sponge: "offstage", Squid: "far" } },
    places, cast: { Sponge: { glb: "missing.glb", height_m: 1.2 }, Squid: { glb: "missing.glb", height_m: 1.8 } },
    geo: { spawn: { at: [5, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
}
let clock = 0;
const step = (s: Awaited<ReturnType<typeof runtime>>, n: number) => { for (let i = 0; i < n; i++) s.update(1 / 60, (clock += 1 / 60)); };
const me = (s: Awaited<ReturnType<typeof runtime>>) => s.api.actors().find((a) => a.who === "Sponge")!;

describe("enter: the step in ends where one can walk on", () => {
  it("a table a step inside the door: he never ends inside it and a later goto still walks", async () => {
    clock = 0;
    const s = await runtime();
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "enter", place: "door" });
    step(s, 120);
    const p = me(s).pos;
    expect(p[0]).toBeGreaterThan(1.05);  // came in, not out
    const inTable = p[0] > 1.6 && p[0] < 2.6 && p[1] > 4.4 && p[1] < 5.6;
    expect(inTable).toBe(false);         // never inside the table's block
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "spot" });
    step(s, 600);
    const q = me(s).pos;
    expect(Math.hypot(q[0] - 6, q[1] - 3)).toBeLessThan(1.0);
  });

  it("the table right at the door: he steps in past its side, not stays in the doorway", async () => {
    clock = 0;
    const s = await runtime([1.1, 4.6, 2.6, 5.4]);
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "enter", place: "door" });
    step(s, 120);
    const p = me(s).pos;
    expect(Math.hypot(p[0] - 1, p[1] - 5)).toBeGreaterThan(0.6);
    expect(p[0]).toBeGreaterThan(1.3);
  });
});
