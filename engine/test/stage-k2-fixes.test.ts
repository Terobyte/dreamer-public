/** К3м v2, rule 9: К2 debt on the runtime path. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from "three";
import { createDirector, type DActor, type DRoom, type DEvent } from "../src/runtime/stage/director.js";
import { startStage } from "../src/runtime/stage/index.js";

// every event the runtime hands the director (snapshot at call time), to assert the walk event itself
const seen: DEvent[] = [];
vi.mock("../src/runtime/stage/director.js", async (orig) => {
  const m = await orig<typeof import("../src/runtime/stage/director.js")>();
  return {
    ...m,
    createDirector: (...a: Parameters<typeof m.createDirector>) => {
      const d = m.createDirector(...a);
      return { ...d, step: (inp: any) => { seen.push(JSON.parse(JSON.stringify(inp.event))); return d.step(inp); } };
    },
  };
});

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const act = (name: string, pos: [number, number], yaw: number, room = "R"): DActor => ({ name, pos, yaw, height: 1.7, level: null, room, walking: false });
afterEach(() => { delete (globalThis as any).window; seen.length = 0; });

async function runtime() {
  (globalThis as any).window = new EventTarget();
  const scene = new Scene();
  const ceil = new BufferGeometry();
  ceil.setAttribute("position", new Float32BufferAttribute([0, 2.6, 0, 4, 2.6, 0, 4, 2.6, 3.5, 0, 2.6, 3.5], 3));
  ceil.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
  const m = new Mesh(ceil, new MeshStandardMaterial());
  m.userData.kind = "ceiling";
  scene.add(m);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  const places = [
    { name: "Spot", id: "spot", kind: "stand", room: "room", level: null, at: [3.2, 2.8], yaw: 0, look: null, obstacle: null, poses: ["stand_at"] },
  ];
  const stage = await startStage({
    scene, camera, stageUrl: "stage/stage.json", sim: null, cameraStyle: "storybook",
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    places, cast: { Mirai: { glb: "missing.glb", height_m: 1.6 } },
    geo: { spawn: { at: [0.6, 0.6] }, floors: [{ room: "room", level: null, outline: [[0, 0], [4, 0], [4, 3.5], [0, 3.5]] }], meshes: [] },
    layers: [{ layer: { level: null, y: 0, origin: [0, 0], w: 250, h: 250 }, bits: new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255) }],
    nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  return { stage, facts: (globalThis as any).window.__critic as any[] };
}

describe("К2 fixes at runtime (r9)", () => {
  it("r9: a valid goto is an enter walk (follow_side) like enter", async () => {
    const { stage, facts } = await runtime();
    stage.update(1 / 60, 0);
    stage.handlers.stage!({ type: "stage", who: "Mirai", action: "goto", place: "Spot" });
    stage.update(0.6, 0.6);
    expect(facts.at(-1).move).not.toBeNull();
    const walk = seen.filter((e) => e.kind === "walk");
    expect(walk.length).toBeGreaterThan(0);
    expect(walk[0].tags?.enter).toBe(true);
    expect(walk[0].speaker).toBe("Mirai");
  });
  it("r9: goto is a walk event with tags.enter and the walker as speaker", () => {
    // director level: the same event the runtime queues for goto (kind walk, speaker = walker, tags.enter)
    const d = createDirector(() => 0.5, { style: "storybook" });
    d.step({ event: { kind: "line", speaker: "a", dt: 0, room: "R", durationS: 3 }, actors: [act("a", [0, 0], 0), act("b", [0, 2], 180)], room: ROOM });
    const w = [act("a", [0, 0], 0), { ...act("b", [0, 2], 180), walking: true, walkLeft: 3 }];
    const o = d.step({ event: { kind: "walk", speaker: "b", dt: 0.1, room: "R", tags: { enter: true } }, actors: w, room: ROOM });
    expect(o.move).toBe("follow_side");
  });
  it("r9: goto after a first line carries tags.enter from the runtime (enter tag, speaker kept)", async () => {
    const { stage, facts } = await runtime();
    stage.update(1 / 60, 0);
    stage.handlers.line!({ type: "line", who: "Mirai", text: "hi", source: "book", dur: 1 });
    stage.update(0.6, 0.6);
    stage.handlers.stage!({ type: "stage", who: "Mirai", action: "goto", place: "Spot" });
    stage.update(0.01, 0.61);
    stage.update(0.6, 1.2);
    const walk = seen.filter((e) => e.kind === "walk");
    expect(walk.length).toBeGreaterThan(0);
    expect(walk[0].tags?.enter).toBe(true);
    expect(walk[0].speaker).toBe("Mirai");
    // only tags.enter yields follow_side (or crane_down while nobody walks yet); the line before was establishing
    expect(["follow_side", "crane_down"]).toContain(facts.slice(-1)[0].move);
    // the facts carry the goto plan, not the earlier line's: a new cut after the line, and no speaker on a walk
    expect(facts.slice(-1)[0].dcut).toBeGreaterThan(facts[0].dcut ?? -1);
    expect(facts.slice(-1)[0].move).not.toBe(facts[0].move);
  });
  it("r9: turn_away sets no enter tag", async () => {
    const { stage, facts } = await runtime();
    stage.update(1 / 60, 0);
    stage.update(0.6, 0.6);
    stage.handlers.stage!({ type: "stage", who: "Mirai", action: "turn_away", look: "Spot" });
    stage.update(0.6, 1.2);
    expect(seen.some((e) => e.tags?.enter)).toBe(false);
    expect(["follow_side", "crane_down"]).not.toContain(facts.at(-1).move);
  });
  it("r9: follow_side on enter has an end, no MOVE_STATIC", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const w = [act("a", [0, 0], 0), { ...act("b", [0, 2], 180), walking: true, walkLeft: 3 }];
    const o = d.step({ event: { kind: "walk", speaker: "b", dt: 0.1, room: "R", tags: { enter: true } }, actors: w, room: ROOM });
    expect(o.move).toBe("follow_side");
    expect(o.end).toBeTruthy();
    expect(o.warnings ?? []).not.toContain("MOVE_STATIC");
  });
  it("r9: one room change is exactly one cut (tick with a walker, enter tag)", () => {
    const a = act("a", [0, 0], 0);
    const d = createDirector(() => 0.5, { style: "storybook" });
    const x = d.step({ event: { kind: "line", speaker: "a", dt: 0, room: "R1" }, actors: [a], room: ROOM });
    const walker = { ...a, room: "R2", walking: true, walkLeft: 4 };
    const y = d.step({ event: { kind: "walk", speaker: "a", dt: 0.1, room: "R2", tags: { enter: true } }, actors: [walker], room: ROOM });
    expect(y.cut - x.cut).toBe(1);
    const z = d.step({ event: { kind: "tick", dt: 0.1, room: "R3" }, actors: [{ ...walker, room: "R3" }], room: ROOM });
    expect(z.cut - y.cut).toBe(1);
  });
  it("r9: anderson frontal blocked at 15 degrees is not labelled frontal", () => {
    const actors = [{ ...act("a", [0, 0], 0), faceYaw: 0 }, act("b", [0, 3], 180)];
    const q = [0.9, 0];
    let i = 0;
    const d = createDirector(() => q[i++ % 2], { style: "anderson" });
    const o = d.step({ event: { kind: "line", speaker: "a", durationS: 4, dt: 0, room: "R" }, actors, room: ROOM, clear: (cam: any) => cam[0] > 0.5 } as any);
    expect(o.move).not.toBe("frontal");
  });
  it("r9: anderson never labels a plan frontal off the face by more than 10 degrees", () => {
    const a = { ...act("a", [0, 0], 0), faceYaw: 70 };
    const b = act("b", [0, 1.5], 180);
    for (const r of [0, 0.5, 0.99]) {
      const d = createDirector(() => r, { style: "anderson" });
      const o = d.step({ event: { kind: "line", speaker: "a", durationS: 4, dt: 0, room: "R" }, actors: [a, b], room: ROOM });
      if (o.move !== "frontal") continue;
      const toCam = Math.atan2(o.cam[0] - a.pos[0], o.cam[2] - a.pos[1]) * 180 / Math.PI;
      const diff = Math.abs(((toCam - 70 + 540) % 360) - 180);
      expect(diff).toBeLessThanOrEqual(10 + 1e-6);
    }
  });
  it("r9: the first event of the scene is tagged first even when it is an enter", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const w = [{ ...act("b", [0, 2], 180), walking: true, walkLeft: 3 }];
    const o = d.step({ event: { kind: "walk", speaker: "b", dt: 0, room: "R", tags: { first: true, enter: true } }, actors: w, room: ROOM });
    expect(o.move).toBe("establishing");
  });
  it("r9: runtime tags first on a scene opening with goto", async () => {
    const { stage, facts } = await runtime();
    stage.handlers.stage!({ type: "stage", who: "Mirai", action: "goto", place: "Spot" });
    stage.update(0.6, 0.6);
    expect(facts.at(-1).move).toBe("establishing");
  });
});
