import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene } from "three";
import { createBridge } from "../src/runtime/bridge.js";
import { startStage } from "../src/runtime/stage/index.js";
import { interRoomDoorStep } from "../src/runtime/stage/path.js";
import { findPath } from "../src/runtime/stage/path.js";
import { yawTo, resolveTouch } from "../src/runtime/stage/places.js";

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 0,
    look: null, obstacle: null, poses: ["lie", "sit", "stand"], lie: { at: [5, 5], yaw: 180, head: [5, 5.5] } },
  { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [6, 5], yaw: 180,
    look: null, obstacle: null, poses: ["sit", "stand"] },
  { name: "door", id: "door", kind: "door", room: "room", level: null, at: [4, 5], yaw: 90,
    look: null, obstacle: null, poses: ["door", "stand"] },
];
const navLayer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
const navBits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
function runtime(start: Record<string, string> = {}, bank: any[] = places) {
  const bits = new Uint8Array(Math.ceil((250 * 250) / 8));
  bits.fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  const stage = startStage({
    scene: new Scene(), camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start },
    places: bank, cast: { Mama: { glb: "missing.glb", height_m: 1.7 } },
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  return stage;
}
async function runUntilStopped(stage: Awaited<ReturnType<typeof runtime>>, seconds = 8) {
  for (let i = 0; i < seconds * 60; i++) stage.update(1 / 60, i / 60);
}
const actor = (stage: Awaited<ReturnType<typeof runtime>>, who = "Mama") =>
  stage.api.actors().find((a) => a.who === who)!;

/** two levels joined by a ramp: chair on L0, bed and door on L1 */
async function rampRuntime() {
  const W = 250, H = 250;
  const bits = () => new Uint8Array(Math.ceil((W * H) / 8)).fill(255);
  const mkLayer = (level: string, y: number) => ({ layer: { level, y, origin: [0, 0], w: W, h: H }, bits: bits() });
  const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const bank: any[] = [
    { name: "chair", id: "chair", kind: "sit", room: "room", level: "L0", at: [1, 5], yaw: 180, look: null, obstacle: null, poses: ["sit", "stand"] },
    { name: "bed", id: "bed", kind: "sit", room: "room", level: "L1", at: [6, 5], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] },
    { name: "door", id: "door", kind: "door", room: "room", level: null, at: [4.5, 5], yaw: 90, look: null, obstacle: null, poses: ["door", "stand"] },
  ];
  const scene = new Scene();
  const stage = await startStage({
    scene, camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    places: bank, cast: { Mama: { glb: "missing.glb", height_m: 1.7 } },
    geo: { spawn: { at: [1, 5] }, floors: [{ room: "room", level: "L0", outline }, { room: "room", level: "L1", outline }], meshes: [] },
    layers: [mkLayer("L0", 0), mkLayer("L1", 1)],
    nav: { ramps: [{ stair: "s", y0: 0, y1: 1, axis: { from: [2, 5], dir: 90, len: 2 }, poly: [] }], doors: {} },
    doorOpen: () => false,
  } as any);
  (stage as any).scene = scene;
  return stage;
}

describe("stage blocking runtime actions", () => {
  it("goto/come faces along the final route segment without an explicit look", async () => {
    const stage = await runtime();
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair" });
    await runUntilStopped(stage);
    const from = [...actor(stage).pos] as [number, number];
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "goto", place: "bed" });
    await runUntilStopped(stage);
    expect(actor(stage).pos[0]).toBeCloseTo(5, 1);
    expect(actor(stage).pos[1]).toBeCloseTo(5, 1);
    const path = findPath(navLayer as any, navBits, from, places[0].at)!;
    const expectedYaw = yawTo(path[path.length - 2]!, path[path.length - 1]!);
    expect(expectedYaw).not.toBeCloseTo(places[0].yaw, 0);
    expect(actor(stage).yaw).toBeCloseTo(expectedYaw, 0);
  });

  it("goto faces an explicit look target instead of the route", async () => {
    const stage = await runtime();
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair" });
    await runUntilStopped(stage);
    const from = [...actor(stage).pos] as [number, number];
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "goto", place: "bed", look: "chair" });
    await runUntilStopped(stage);
    const expectedLookYaw = yawTo(places[0].at, places[1].at);
    const path = findPath(navLayer as any, navBits, from, places[0].at)!;
    const routeYaw = yawTo(path[path.length - 2]!, path[path.length - 1]!);
    expect(expectedLookYaw).not.toBeCloseTo(routeYaw, 0);
    expect(actor(stage).yaw).toBeCloseTo(expectedLookYaw, 0);
  });

  it("exit stays onstage while walking and becomes offstage only at the door", async () => {
    const stage = await runtime();
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair" });
    await runUntilStopped(stage);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "exit" });
    expect((actor(stage) as any).offstage).toBeFalsy();
    const frames: Array<{ pos: [number, number]; offstage: boolean }> = [];
    for (let i = 0; i < 240; i++) {
      stage.update(1 / 60, i / 60);
      const a = actor(stage);
      frames.push({ pos: [...a.pos] as [number, number], offstage: (a as any).offstage });
    }
    const movedFrames = frames.filter((frame, i) => i > 0 &&
      Math.hypot(frame.pos[0] - frames[i - 1]!.pos[0], frame.pos[1] - frames[i - 1]!.pos[1]) > 1e-6);
    expect(movedFrames.length).toBeGreaterThan(0);
    const firstOff = frames.findIndex((f) => f.offstage);
    expect(firstOff).toBeGreaterThan(0);
    expect(movedFrames.filter((f) => frames.indexOf(f) < firstOff).length).toBeGreaterThan(0);
    expect(frames.at(-1)!.offstage).toBe(true);
    // the actor walks through the door: last frame before offstage is behind the door plane (door yaw 90 -> inside is +X)
    const R = 0.3;
    const last = frames[firstOff - 1]!;
    expect(last.pos[0]).toBeLessThanOrEqual(places[2].at[0] - R);
  });

  it("exit is visible mid-way: walks through the door plane onstage, no teleport", async () => {
    const stage = await runtime();
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair" });
    await runUntilStopped(stage);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "exit" });
    const frames: Array<{ pos: [number, number]; offstage: boolean }> = [];
    for (let i = 0; i < 600; i++) {
      stage.update(1 / 60, i / 60);
      const a = actor(stage) as any;
      frames.push({ pos: [...a.pos] as [number, number], offstage: a.offstage });
    }
    const firstOff = frames.findIndex((f) => f.offstage);
    expect(firstOff).toBeGreaterThan(0);
    // visible on the approach, inside the room
    expect(frames.slice(0, firstOff).some((f) => f.pos[0] > 4.5)).toBe(true);
    // consecutive onstage frames with the centre behind the door plane (outside is -X):
    // a single frame outside proves nothing, the actor must keep walking there
    const doorX = places[2].at[0];
    const R = 0.3;
    let run: typeof frames = [];
    let best: typeof frames = [];
    for (let i = 0; i < firstOff; i++) {
      if (frames[i]!.pos[0] < doorX - 0.01) run.push(frames[i]!);
      else {
        if (run.length > best.length) best = run;
        run = [];
      }
    }
    if (run.length > best.length) best = run;
    expect(best.length).toBeGreaterThanOrEqual(2);
    // the sustained walk must reach at least the capsule radius behind the plane
    expect(Math.min(...best.map((f) => f.pos[0]))).toBeLessThanOrEqual(doorX - R);
    // the actor keeps walking behind the plane (not a single frozen frame)
    const travel = Math.hypot(
      best.at(-1)!.pos[0] - best[0]!.pos[0],
      best.at(-1)!.pos[1] - best[0]!.pos[1],
    );
    expect(travel).toBeGreaterThan(0.05);
    // no teleport on the way to and through the plane: one frame (1/60 s at 1.4 m/s) moves ~0.023 m
    for (let i = 1; i < firstOff; i++) {
      const step = Math.hypot(frames[i]!.pos[0] - frames[i - 1]!.pos[0], frames[i]!.pos[1] - frames[i - 1]!.pos[1]);
      expect(step).toBeLessThanOrEqual(0.1);
    }
  });

  it("exit called on a ramp waits, then walks through the door and offstage", async () => {
    // the ride is ~2 m long; try several frames until the exit really fires mid-ramp (queued)
    let stage: Awaited<ReturnType<typeof rampRuntime>> | null = null;
    for (const f of [40, 60, 80, 100, 120]) {
      const s = await rampRuntime();
      s.handlers.start!({ type: "start", who: "Mama", place: "chair" });
      await runUntilStopped(s, 0.5);
      s.handlers.stage!({ type: "stage", who: "Mama", action: "goto", place: "bed" });
      for (let i = 0; i < f; i++) s.update(1 / 60, i / 60);
      s.handlers.stage!({ type: "stage", who: "Mama", action: "exit" });
      if (s.warnings().join(" ").match(/step off the ramp/)) {
        stage = s;
        break;
      }
    }
    // the loop above proves the exit fired while queued: without the wait it never fires mid-ramp
    expect(stage).not.toBeNull();
    const yOf = (): number => ((stage as any).scene.getObjectByName("actor:Mama") as any).position.y;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 3600; i++) {
      stage!.update(1 / 60, 100 + i / 60);
      xs.push(actor(stage!).pos[0]);
      ys.push(yOf());
    }
    expect((actor(stage!) as any).offstage).toBe(true);
    // through the door: the centre ends past the plane by the capsule radius (door yaw 90 -> outside is -X)
    expect(actor(stage!).pos[0]).toBeLessThanOrEqual(4.5 - 0.3);
    // F3: the second leg keeps the actor's level (door has level null, the actor exits from L1, y=1)
    expect(ys.at(-1)).toBeGreaterThan(0.85);
    expect(ys.at(-1)).toBeLessThan(1.2);
    // only frames after the actor first stands on L1: the early ramp climb
    // (x < 4.49 while y rises 0 -> 1) is not the exit crossing
    const established = ys.findIndex((y) => y > 0.9);
    expect(established).toBeGreaterThanOrEqual(0);
    const pastYs = ys.filter((_, i) => i > established && xs[i]! < 4.5 - 0.01);
    expect(pastYs.length).toBeGreaterThan(0);
    for (const y of pastYs) expect(y).toBeGreaterThan(0.85);
  });

  it("exit through a door with no known exit side keeps the old stop and warns", async () => {
    const noSide = places.map((p) => (p.name === "door" ? { ...p, yaw: undefined } : p));
    const stage = await runtime({}, noSide);
    stage.handlers.start!({ type: "start", who: "Mama", place: "chair" });
    await runUntilStopped(stage);
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "exit" });
    await runUntilStopped(stage, 10);
    expect((actor(stage) as any).offstage).toBe(true);
    expect(Math.hypot(actor(stage).pos[0] - 4, actor(stage).pos[1] - 5)).toBeLessThanOrEqual(0.85);
    expect(stage.warnings().join(" ")).toMatch(/exit side/);
  });

  it("empty poses list counts as [stand_at]", () => {
    const place = { ...places[1], poses: [] };
    const warnings: string[] = [];
    const r: any = resolveTouch({ places: [place], claims: {}, actor: { who: "Mama", at: [1, 1] }, name: "chair", pose: "sit", warnings });
    expect(r.pose).toBe("stand_at");
    expect(warnings.join(" ")).toContain('no pose "sit"');
    const ok: any = resolveTouch({ places: [place], claims: {}, actor: { who: "Mama", at: [1, 1] }, name: "chair", pose: "stand_at", warnings });
    expect(ok.pose).toBe("stand_at");
  });

  it("enter walks from the door to insidePos and remains onstage", async () => {
    const stage = await runtime();
    stage.handlers.start!({ type: "start", who: "Mama", place: "door", offstage: true });
    stage.handlers.stage!({ type: "stage", who: "Mama", action: "enter", place: "door" });
    const step = interRoomDoorStep([4, 5], 90, 1);
    expect(actor(stage).pos).toEqual(step.doorPos);
    expect((actor(stage) as any).offstage).toBe(false);
    await runUntilStopped(stage);
    expect(actor(stage).pos[0]).toBeCloseTo(step.insidePos[0], 2);
    expect(actor(stage).pos[1]).toBeCloseTo(step.insidePos[1], 2);
    expect((actor(stage) as any).offstage).toBe(false);
  });

  it("bridge start and stage events place the actor before the first line", async () => {
    const stage = await runtime();
    const bridge = createBridge({ door: () => null }, { post: () => undefined, warn: () => undefined }, stage.handlers);
    bridge.handle({ type: "start", start: [{ who: "Mama", place: "bed", pose: "lie" }] });
    expect(actor(stage).pos).toEqual([5, 5]);
    bridge.handle({ type: "stage", who: "Mama", action: "goto", place: "chair", pose: "sit" });
    await runUntilStopped(stage);
    expect(actor(stage).act).toBe("sit");
    expect(actor(stage).pos[0]).toBeCloseTo(6, 1);
    bridge.handle({ type: "line", who: "Mama", text: "Hello", dur: 1 });
    expect(stage.api.subs().join(" ")).toContain("Hello");
  });
});
