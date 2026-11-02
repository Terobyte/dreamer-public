import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { startStage } from "../src/runtime/stage/index.js";
import { separate } from "../src/runtime/stage/separate.js";
import { CELL, navBit } from "../src/nav/floor.js";

// Н9: separate() была мёртвым кодом — актёры в рантайме стояли друг в друге.

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const W = 250, H = 250;
const layer = { level: null, y: 0, origin: [0, 0], w: W, h: H };
const full = (): Uint8Array => new Uint8Array(Math.ceil((W * H) / 8)).fill(255);
const cast = { Mama: { glb: "missing.glb", height_m: 1.7 }, Papa: { glb: "missing.glb", height_m: 1.8 } };

async function runtime(bank: any[], start: Record<string, string> = {}, bits = full()) {
  return startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start },
    places: bank, cast,
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
}
const run = (stage: any, frames = 30): void => {
  for (let i = 0; i < frames; i++) stage.update(1 / 60, 1 + i / 60);
};
const posOf = (stage: any, who: string): [number, number] => stage.api.actors().find((a: any) => a.who === who)!.pos;
const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("separate() in the runtime", () => {
  it("two actors that start on one spot (no start place -> both on places[0]) are set apart", async () => {
    const bank = [{ name: "rug", id: "rug", kind: "stand", room: "room", level: null, at: [5, 5], yaw: 0, look: null, obstacle: null, poses: ["stand"] }];
    const stage = await runtime(bank);
    run(stage);
    // box stand-ins 0.5 m wide: capsule radius 0.25 each
    expect(dist(posOf(stage, "Mama"), posOf(stage, "Papa"))).toBeGreaterThan(0.45);
  });

  it("a seated actor stays on its seat; the standing one steps out", async () => {
    const bank = [{ name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] }];
    const stage = await runtime(bank, { Mama: "chair" });
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair", pose: "sit" } as any);
    run(stage);
    expect(dist(posOf(stage, "Mama"), [5, 5])).toBeLessThan(1e-6);
    expect(dist(posOf(stage, "Papa"), [5, 5])).toBeGreaterThan(0.45);
  });

  it("stage.json start_pose sit seats the actor at load, like a start event with pose sit (Koshakan: Mirai stood by the bed)", async () => {
    const bank = [{ name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] }];
    const stage = await startStage({
      scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
      stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Mama: "chair" }, start_pose: { Mama: "sit" } },
      places: bank, cast,
      geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
      layers: [{ layer, bits: full() }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
    } as any);
    run(stage);
    const mama = stage.api.actors().find((a: any) => a.who === "Mama")!;
    expect(mama.act).toBe("sit");
    expect(dist(mama.pos, [5, 5])).toBeLessThan(1e-6);
  });

  it("a walker whose goal is next to a seated actor arrives (no endless push-back), then stands clear of her", async () => {
    const bank = [
      { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] },
      { name: "rug", id: "rug", kind: "stand", room: "room", level: null, at: [5.2, 5], yaw: 0, look: null, obstacle: null, poses: ["stand"] },
      { name: "far", id: "far", kind: "stand", room: "room", level: null, at: [2, 2], yaw: 0, look: null, obstacle: null, poses: ["stand"] },
    ];
    const stage = await runtime(bank, { Mama: "chair", Papa: "far" });
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair", pose: "sit" } as any);
    run(stage, 5);
    stage.handlers.touch!({ type: "touch", who: "Papa", place: "rug" } as any);
    for (let i = 0; i < 60 * 8; i++) stage.update(1 / 60, 2 + i / 60);
    const papa = stage.api.actors().find((a: any) => a.who === "Papa")!;
    expect(dist(papa.pos, [5.2, 5])).toBeLessThan(0.6);
    expect(dist(posOf(stage, "Mama"), [5, 5])).toBeLessThan(1e-6);
    expect(dist(papa.pos, posOf(stage, "Mama"))).toBeGreaterThan(0.45);
    // standing still now: the walk ended, nothing keeps pushing him
    const p0 = papa.pos;
    run(stage, 30);
    expect(dist(posOf(stage, "Papa"), p0)).toBeLessThan(1e-6);
  });

  it("a push that would leave the walkable floor is refused", async () => {
    // a corridor 0.2 m wide along z: a sideways push would put an actor outside the nav
    const bits = new Uint8Array(Math.ceil((W * H) / 8));
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = (i + 0.5) * CELL;
        if (x < 4.9 || x > 5.1) continue;
        const n = j * W + i;
        bits[n >> 3] |= 1 << (n & 7);
      }
    }
    const bank = [{ name: "spot", id: "spot", kind: "stand", room: "room", level: null, at: [5, 5], yaw: 0, look: null, obstacle: null, poses: ["stand"] }];
    const stage = await runtime(bank, {}, bits);
    run(stage);
    for (const who of ["Mama", "Papa"]) {
      const p = posOf(stage, who);
      expect(navBit(layer as any, bits, p[0], p[1])).toBe(true);
    }
  });
});

describe("separate() fixed actors", () => {
  it("a fixed actor never moves, the free one takes the whole push", () => {
    const r = separate([[0, 0], [0.1, 0]], 0.25, { fixed: [true, false] });
    expect(r.pos[0]).toEqual([0, 0]);
    expect(dist(r.pos[0], r.pos[1])).toBeGreaterThan(0.5 - 1e-6);
  });
  it("two fixed actors are left as they are", () => {
    const r = separate([[0, 0], [0.1, 0]], 0.25, { fixed: [true, true] });
    expect(r.pos).toEqual([[0, 0], [0.1, 0]]);
  });
});

describe("capsuleRadius", () => {
  it("a T-pose body (arms out, 1.7 m span) is not a 0.85 m capsule: capped at 0.3 m; a thin one is at least 0.12 m", async () => {
    const { BoxGeometry, Group, Mesh } = await import("three");
    const { capsuleRadius } = await import("../src/runtime/stage/actors.js");
    const t = new Group();
    t.add(new Mesh(new BoxGeometry(1.7, 1.7, 0.25)));
    expect(capsuleRadius(t)).toBeCloseTo(0.3, 6);
    const thin = new Group();
    thin.add(new Mesh(new BoxGeometry(0.1, 1.7, 0.1)));
    expect(capsuleRadius(thin)).toBeCloseTo(0.12, 6);
    const box = new Group();
    box.add(new Mesh(new BoxGeometry(0.5, 1.7, 0.3)));
    expect(capsuleRadius(box)).toBeCloseTo(0.25, 6);
  });
});
