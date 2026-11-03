/** Squidward v8, Nov 3 ("они же ушли на улицу"): the story ends "the two of them walked to the front door together";
 *  they reached the door and the film stayed in the empty room. The prototype (h0/squid_live/duo.html) had a door that
 *  takes you out to Conch Street, a separate place, the San Andreas way. A door place with `to` names where one comes
 *  out: an actor who walks to it (goto it, or exit by it) comes out there, on that place's level, facing its yaw. */
import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

const room: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const street: Array<[number, number]> = [[12, 0], [24, 0], [24, 12], [12, 12]];
const places: any[] = [
  { name: "front door", id: "front", kind: "door", room: "room", level: null, at: [5, 9.6], yaw: 0, look: null, obstacle: null, poses: ["door"], to: "street door" },
  { name: "street door", id: "street_door", kind: "stand", room: "street", level: null, at: [18, 5], yaw: 180, look: null, obstacle: null, poses: ["stand_at"] },
  { name: "corner", id: "corner", kind: "stand", room: "room", level: null, at: [3, 3], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
];

async function runtime(extra: any[] = [], log: Array<[string, boolean]> = []) {
  const W = 650, H = 650;  // 4 cm cells: 26 m, the room and the street apart from it
  const bits = new Uint8Array(Math.ceil((W * H) / 8)).fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: W, h: H };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Sponge: "corner" } },
    places: [...places, ...extra], cast: { Sponge: { glb: "missing.glb", height_m: 1.2 } },
    geo: { spawn: { at: [5, 5] }, floors: [{ room: "room", level: null, outline: room }, { room: "street", level: null, outline: street }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false, door: (id: string, open: boolean) => log.push([id, open]),
  } as any);
}
let clock = 0;
const step = (s: Awaited<ReturnType<typeof runtime>>, n: number) => { for (let i = 0; i < n; i++) s.update(1 / 60, (clock += 1 / 60)); };
const me = (s: Awaited<ReturnType<typeof runtime>>) => s.api.actors().find((a) => a.who === "Sponge")!;

describe("a door that leads to another place", () => {
  it("goto the door: he comes out at its `to` place, facing its yaw, in view", async () => {
    clock = 0;
    const s = await runtime();
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "front door", pose: "door" });
    step(s, 600);
    const a = me(s);
    expect(Math.hypot(a.pos[0] - 18, a.pos[1] - 5)).toBeLessThan(0.6);
    expect(Math.abs((((a.yaw - 180) % 360) + 540) % 360 - 180)).toBeLessThan(10);
    expect(a.offstage ?? false).toBe(false);
  });
  it("exit by the door: the same, not offstage", async () => {
    clock = 0;
    const s = await runtime();
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "exit" });
    step(s, 600);
    const a = me(s);
    expect(Math.hypot(a.pos[0] - 18, a.pos[1] - 5)).toBeLessThan(0.6);
    expect(a.offstage ?? false).toBe(false);
  });
  it("out on the street, a door that leads into the pineapple: its door opens, he steps in, it shuts behind", async () => {
    clock = 0;
    const log: Array<[string, boolean]> = [];
    // the street side of the pineapple door, and the door inside it that one comes in by
    const extra = [
      { name: "pineapple door", id: "pine_out", kind: "door", room: "street", level: null, at: [22, 10], yaw: 180, look: null, obstacle: null, poses: ["door"], to: "pineapple hall" },
      { name: "pineapple hall", id: "pine_in", kind: "door", room: "room", level: null, at: [9.6, 5], yaw: 270, look: null, obstacle: null, poses: ["door"] },
    ];
    const s = await runtime(extra, log);
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "front door", pose: "door" });
    step(s, 600);
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "goto", place: "pineapple door", pose: "door" });
    step(s, 900);
    const a = me(s);
    // a step inside the pineapple's door (yaw 270: in toward -x), not in the doorway, not offstage
    expect(a.pos[0]).toBeLessThan(9.6);
    expect(Math.hypot(a.pos[0] - 9.6, a.pos[1] - 5)).toBeLessThan(2);
    expect(a.offstage ?? false).toBe(false);
    // each door opened and shut again: the front, the street side, the inside
    for (const id of ["front", "pine_out", "pine_in"]) {
      expect(log.filter(([d, o]) => d === id && o).length).toBeGreaterThan(0);
      expect(log.filter(([d, o]) => d === id && !o).length).toBeGreaterThan(0);
    }
  });
});
