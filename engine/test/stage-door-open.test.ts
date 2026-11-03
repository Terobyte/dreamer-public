import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";

// Squidward, Nov 3 ("они ведь выходят на улицу, там дверь есть с функцией?"): the page's doors swing open and shut
// for the player (doors.ts), but an actor walking out went through the shut leaf. Enter and exit open the door they
// pass, and it shuts 2 s after the last one is through.
const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "front door", id: "front", kind: "door", room: "room", level: null, at: [1, 5], yaw: 90, look: [0.2, 5], obstacle: null, poses: ["door"] },
  { name: "spot", id: "spot", kind: "stand", room: "room", level: null, at: [3, 5], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
];
async function runtime(calls: Array<[string, boolean, number]>, clock: { t: number }) {
  const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Sponge: "spot" } },
    places, cast: { Sponge: { glb: "missing.glb", height_m: 1.2 } },
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
    door: (id: string, open: boolean) => calls.push([id, open, clock.t]),
  } as any);
}

describe("stage doors open for who passes", () => {
  it("exit opens the door, the actor goes through, it shuts behind him", async () => {
    const calls: Array<[string, boolean, number]> = [];
    const clock = { t: 0 };
    const s = await runtime(calls, clock);
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "exit" });
    for (let i = 0; i < 900; i++) s.update(1 / 60, (clock.t += 1 / 60));
    const me = s.api.actors().find((a) => a.who === "Sponge")!;
    expect(me.offstage).toBe(true);
    const open = calls.find((c) => c[0] === "front" && c[1]);
    const shut = calls.find((c) => c[0] === "front" && !c[1]);
    expect(open).toBeTruthy();
    expect(shut).toBeTruthy();
    expect(shut![2]).toBeGreaterThan(open![2]);
  });

  it("enter opens the door he comes in by", async () => {
    const calls: Array<[string, boolean, number]> = [];
    const clock = { t: 0 };
    const s = await runtime(calls, clock);
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "exit" });
    for (let i = 0; i < 900; i++) s.update(1 / 60, (clock.t += 1 / 60));
    calls.length = 0;
    s.handlers.stage!({ type: "stage", who: "Sponge", action: "enter", place: "front door" });
    for (let i = 0; i < 400; i++) s.update(1 / 60, (clock.t += 1 / 60));
    expect(calls[0]?.slice(0, 2)).toEqual(["front", true]);
    expect(calls.some((c) => c[0] === "front" && !c[1])).toBe(true);
  });
});
