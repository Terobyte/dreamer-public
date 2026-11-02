import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { Bone, BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from "three";
import { createBridge } from "../src/runtime/bridge.js";
import { startStage } from "../src/runtime/stage/index.js";
import { parseShotplan, easeOf, shakeOf } from "../src/runtime/stage/shotplan.js";
// @ts-ignore: plain .mjs module without types
import { pickEvent } from "../bin/rec_event.mjs";

type V3 = [number, number, number];
const outline: Array<[number, number]> = [[0, 0], [4, 0], [4, 3.5], [0, 3.5]];
const W = 250, H = 250;

function quad(kind: string, p: [V3, V3, V3, V3]): Mesh {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(p.flat(), 3));
  g.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
  const m = new Mesh(g, new MeshStandardMaterial());
  m.name = kind;
  m.userData.kind = kind;
  return m;
}
/** vertical quad across the segment camera -> look (x 1..3, y 0..2.6) at depth z */
const across = (kind: string, z: number): Mesh => quad(kind, [[1, 0, z], [3, 0, z], [3, 2.6, z], [1, 2.6, z]]);

async function room(plan?: unknown) {
  const scene = new Scene();
  const meshes: Record<string, Mesh> = {
    wall: across("wall", 0),
    band: across("band", -0.2),
    cap: across("cap", -0.4),
    reveal: across("reveal", -0.6),
    prop: across("prop", 0.5),
    east: quad("wall", [[4, 0, 0], [4, 0, 3.5], [4, 2.6, 3.5], [4, 2.6, 0]]),
    ceiling: quad("ceiling", [[0, 2.6, 0], [4, 2.6, 0], [4, 2.6, 3.5], [0, 2.6, 3.5]]),
  };
  for (const m of Object.values(meshes)) scene.add(m);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  const bits = new Uint8Array(Math.ceil((W * H) / 8)).fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: W, h: H };
  const ceilGeo = { id: "room:ceiling", positions: [0, 2.6, 0, 4, 2.6, 0, 4, 2.6, 3.5], normals: [], uvs: [], indices: [0, 1, 2] };
  const stage = await startStage({
    scene, camera, stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    plan,
    places: [], cast: { Mirai: { glb: "missing.glb", height_m: 1.6 } },
    geo: { spawn: { at: [2, 1.75] }, floors: [{ room: "room", level: null, outline }], meshes: [ceilGeo] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  const g = scene.getObjectByName("actor:Mirai")!;
  const head = new Bone();
  head.name = "head";
  head.position.set(0, 1.5, 0);
  const hips = new Bone();
  hips.name = "hips";
  hips.position.set(0, 0.9, 0);
  g.add(head, hips);
  return { stage, camera, scene, meshes, head };
}
const pos = (c: PerspectiveCamera): V3 => [c.position.x, c.position.y, c.position.z];
const near = (a: V3, b: V3, eps = 1e-3) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(eps);
};
const line = (beat: number, dur?: number) => ({ type: "line", who: "Mirai", text: "hi", source: "book", beat, ...(dur === undefined ? {} : { dur }) });
const narr = (beat: number, dur?: number) => ({ type: "narrator", cause: "book", text: "and so", beat, ...(dur === undefined ? {} : { dur }) });
const plan = (shots: any[]) => ({ version: 1, scene: "t", shots });
const A = (over: Record<string, unknown> = {}) => ({
  name: "A", at: "B1", to: "B1e",
  from: { pos: [1, 1.5, 1], look: [2, 1, 1.75], fov: 40 },
  end: { pos: [3, 1.5, 1], look: [2, 1, 1.75], fov: 30 },
  ease: "lin", ...over,
});
const fixed = (name: string, at: unknown, to: unknown, p: V3, over: Record<string, unknown> = {}) =>
  ({ name, at, to, from: { pos: p, look: [2, 1, 1.75], fov: 40 }, ...over });

afterEach(() => {
  delete (globalThis as any).window;
});

describe("shotplan format", () => {
  it("reads the Sonnet bathroom example without warnings", () => {
    const j = JSON.parse(readFileSync(new URL("../../h0/make/testdata/shots_example.json", import.meta.url), "utf8"));
    const warn: string[] = [];
    const p = parseShotplan(j, warn);
    expect(warn).toEqual([]);
    expect(p!.shots.length).toBe(j.shots.length);
  });
  it("ease: lin, io = smoothstep, in, out; default io", () => {
    expect(easeOf("lin")(0.5)).toBeCloseTo(0.5, 9);
    expect(easeOf("io")(0.25)).toBeCloseTo(3 * 0.0625 - 2 * 0.015625, 9);
    expect(easeOf(undefined)(0.25)).toBeCloseTo(0.15625, 9);
    expect(easeOf("in")(0.5)).toBeCloseTo(0.25, 9);
    expect(easeOf("out")(0.5)).toBeCloseTo(0.75, 9);
  });
  it("shake is the fixed sine formula, each axis within the amplitude", () => {
    const a = 0.01, t = 0.25;
    const s = shakeOf(a, t);
    expect(s[0]).toBeCloseTo(a * Math.sin(2 * Math.PI * 1.3 * t), 6);
    expect(s[1]).toBeCloseTo(a * 0.5 * Math.sin(2 * Math.PI * 1.7 * t + 1), 6);
    expect(s[2]).toBeCloseTo(a * Math.sin(2 * Math.PI * 1.1 * t + 2), 6);
    for (let k = 0; k < 200; k++) for (const v of shakeOf(a, k * 0.037)) expect(Math.abs(v)).toBeLessThanOrEqual(a);
  });
});

describe("shotplan runtime: camera", () => {
  it("lin B1 -> B1e: exactly half way after 1 s of a 2 s beat, no smoothing; fov follows", async () => {
    const { stage, camera } = await room(plan([A()]));
    stage.update(1 / 60, 10);
    stage.handlers.line!(line(1, 2));
    stage.update(1, 11);
    near(pos(camera), [2, 1.5, 1]);
    expect(camera.fov).toBeCloseTo(35, 6);
  });
  it("a beat between update(10) and update(10.5) starts at 10", async () => {
    const { stage, camera } = await room(plan([A()]));
    stage.update(1 / 60, 10);
    stage.handlers.narrator!(narr(1, 2));
    stage.update(0.5, 10.5);
    near(pos(camera), [1.5, 1.5, 1]);
  });
  it("a repeated beat does not move its start", async () => {
    const { stage, camera } = await room(plan([A()]));
    stage.update(1 / 60, 10);
    stage.handlers.line!(line(1, 2));
    stage.update(0.5, 10.5);
    stage.handlers.line!(line(1, 2));
    stage.update(0.5, 11);
    near(pos(camera), [2, 1.5, 1]);
  });
  it("io / in / out at the middle and a quarter", async () => {
    for (const [ease, at, frac] of [["io", 10.5, 0.15625], ["in", 11, 0.25], ["out", 11, 0.75]] as const) {
      const { stage, camera } = await room(plan([A({ ease })]));
      stage.update(1 / 60, 10);
      stage.handlers.line!(line(1, 2));
      stage.update(at - 10, at);
      near(pos(camera), [1 + 2 * frac, 1.5, 1]);
    }
  });
  it("look on a bone follows the moving bone", async () => {
    const { stage, camera, head } = await room(plan([A({ from: { pos: [1, 1.5, 1], look: { actor: "Mirai", bone: "head", o: [0, -0.02, 0] }, fov: 40 }, end: undefined })]));
    stage.update(1 / 60, 10);
    stage.handlers.line!(line(1, 2));
    const check = () => {
      const b = new Vector3();
      head.getWorldPosition(b);
      b.y -= 0.02;
      const want = b.sub(camera.position).normalize();
      const d = new Vector3();
      camera.getWorldDirection(d);
      expect(d.angleTo(want)).toBeLessThan(1e-4);
    };
    stage.update(0.5, 10.5);
    check();
    head.position.x += 0.6;
    head.position.z -= 0.4;
    stage.update(0.5, 11);
    check();
    near(pos(camera), [1, 1.5, 1]);
  });
  it("shake 0.01: offset at tau = 0.25 matches the formula", async () => {
    const { stage, camera } = await room(plan([fixed("S", 0, 10, [2, 1.5, 1], { shake: 0.01 })]));
    stage.update(1 / 60, 100);
    stage.update(0.25, 100.25);
    const s = [0.01 * Math.sin(2 * Math.PI * 1.3 * 0.25), 0.005 * Math.sin(2 * Math.PI * 1.7 * 0.25 + 1), 0.01 * Math.sin(2 * Math.PI * 1.1 * 0.25 + 2)];
    near(pos(camera), [2 + s[0], 1.5 + s[1], 1 + s[2]], 1e-6);
  });
});

describe("shotplan runtime: timing", () => {
  it("numeric times count from the first update: at 2, to 4 -> active from 102 to 104", async () => {
    const { stage, camera } = await room(plan([fixed("N", 2, 4, [1, 1.2, 1])]));
    stage.update(1 / 60, 100);
    stage.update(1.9, 101.9);
    expect(pos(camera)).not.toEqual([1, 1.2, 1]);
    stage.update(0.1, 102);
    near(pos(camera), [1, 1.2, 1], 1e-9);
    stage.update(1.99, 103.99);
    near(pos(camera), [1, 1.2, 1], 1e-9);
    stage.update(0.01, 104);
    expect(Math.hypot(camera.position.x - 1, camera.position.y - 1.2, camera.position.z - 1)).toBeGreaterThan(1e-3);
  });
  it("two plans meeting: the second is active at the joint", async () => {
    const { stage, camera } = await room(plan([fixed("P", 0, 2, [1, 1.2, 1]), fixed("Q", 2, 4, [3, 1.3, 2.5])]));
    stage.update(1 / 60, 50);
    stage.update(1, 51);
    near(pos(camera), [1, 1.2, 1], 1e-9);
    stage.update(1, 52);
    near(pos(camera), [3, 1.3, 2.5], 1e-9);
  });
  it("an ended later plan yields to the earlier one still active ([at, to) wins by latest start)", async () => {
    const { stage, camera } = await room(plan([fixed("P", 0, 10, [1, 1.2, 1]), fixed("Q", 2, 3, [3, 1.3, 2.5])]));
    stage.update(1 / 60, 50);
    stage.update(1, 52.5);
    near(pos(camera), [3, 1.3, 2.5], 1e-9);
    stage.update(1, 55);
    near(pos(camera), [1, 1.2, 1], 1e-9);
  });
  it("without a plan, with a waiting plan (B3 never came) and with to <= at: the director's frame, byte for byte", async () => {
    const base = await room();
    const wait = await room(plan([{ ...A(), at: "B3", to: "B3e" }]));
    const bad = await room(plan([fixed("bad", 5, 3, [1, 1.2, 1])]));
    expect(bad.stage.warnings().some((w) => w.includes("bad"))).toBe(true);
    for (const r of [base, wait, bad]) {
      r.stage.update(1 / 60, 10);
      r.stage.handlers.line!(line(1, 2));
    }
    for (let i = 1; i < 120; i++) for (const r of [base, wait, bad]) r.stage.update(1 / 60, 10 + i / 60);
    expect(pos(wait.camera)).toEqual(pos(base.camera));
    expect(pos(bad.camera)).toEqual(pos(base.camera));
    expect(bad.camera.fov).toBe(base.camera.fov);
  });
  it("no shotplan in stage.json -> director with a shotplan warning", async () => {
    const { stage } = await room();
    expect(stage.warnings().some((w) => w.includes("shotplan"))).toBe(true);
  });
  it("a beat without dur ends when the next beat comes", async () => {
    const { stage, camera } = await room(plan([fixed("L", "B1e", "B1e+5", [1, 1.2, 1], { end: { pos: [3, 1.2, 1], look: [2, 1, 1.75] }, ease: "lin" })]));
    stage.update(1 / 60, 10);
    stage.handlers.narrator!(narr(1));
    stage.update(1, 11);
    expect(pos(camera)).not.toEqual([1, 1.2, 1]);
    stage.update(1, 12);
    stage.handlers.line!(line(2, 3));
    stage.update(1, 13);
    near(pos(camera), [1.4, 1.2, 1]);
  });
  it("the last beat without dur ends at END (book_end)", async () => {
    const { stage, camera } = await room(plan([fixed("L", "B1e", "B1e+5", [1, 1.2, 1], { end: { pos: [3, 1.2, 1], look: [2, 1, 1.75] }, ease: "lin" })]));
    stage.update(1 / 60, 10);
    stage.handlers.narrator!(narr(1));
    stage.update(1, 11);
    stage.handlers.book_end!({ type: "book_end" });
    stage.update(1, 12);
    near(pos(camera), [1.4, 1.2, 1]);
  });
  for (const [name, fire] of [
    ["book_end", (s: any) => s.handlers.book_end!({ type: "book_end", scene: "t" })],
    ["scene_end", (s: any) => s.handlers.scene_end!({ type: "transition", cause: "book", scene: "next" })],
  ] as const) {
    it(`a plan to END lasts in its end point until ${name}, and stops on it`, async () => {
      const { stage, camera } = await room(plan([A({ to: "END" })]));
      stage.update(1 / 60, 10);
      stage.handlers.line!(line(1, 2));
      stage.update(10, 20);
      near(pos(camera), [3, 1.5, 1], 1e-9);
      fire(stage);
      stage.update(0.5, 20.5);
      expect(Math.hypot(camera.position.x - 3, camera.position.y - 1.5, camera.position.z - 1)).toBeGreaterThan(1e-3);
    });
  }
});

describe("shotplan runtime: cut, clamp, critic", () => {
  const cutShot = (y: number) => fixed("C", 0, 1, [2, y, -0.8], { cut: true });
  it("cut at y 1.5 hides crossed wall/band/cap/reveal, keeps the ceiling, the prop and an uncrossed wall", async () => {
    const { stage, camera, meshes } = await room(plan([cutShot(1.5)]));
    stage.update(1 / 60, 0);
    stage.update(0.5, 0.5);
    near(pos(camera), [2, 1.5, -0.8], 1e-9);
    for (const k of ["wall", "band", "cap", "reveal"]) expect(meshes[k].visible, k).toBe(false);
    for (const k of ["prop", "east", "ceiling"]) expect(meshes[k].visible, k).toBe(true);
  });
  it("cut at y 2.58 hides the ceiling too", async () => {
    const { stage, meshes } = await room(plan([cutShot(2.58)]));
    stage.update(1 / 60, 0);
    stage.update(0.5, 0.5);
    expect(meshes.ceiling.visible).toBe(false);
  });
  it("everything is back on the next plan without cut, and in a gap before it", async () => {
    const { stage, meshes } = await room(plan([cutShot(2.58), fixed("B", 2, 3, [1, 1.5, 1])]));
    stage.update(1 / 60, 0);
    stage.update(0.5, 0.5);
    expect(meshes.wall.visible).toBe(false);
    stage.update(1, 1.5);
    for (const m of Object.values(meshes)) expect(m.visible).toBe(true);
    stage.update(1, 2.5);
    for (const m of Object.values(meshes)) expect(m.visible).toBe(true);
  });
  it("cut followed directly by a plan without cut: all visible", async () => {
    const { stage, meshes } = await room(plan([cutShot(2.58), fixed("B", 1, 3, [1, 1.5, 1])]));
    stage.update(1 / 60, 0);
    stage.update(0.5, 0.5);
    stage.update(1, 1.5);
    for (const m of Object.values(meshes)) expect(m.visible).toBe(true);
  });
  it("critic facts: shot name inside a plan, null outside; point behind the wall without cut -> clamped", async () => {
    (globalThis as any).window = new EventTarget();
    const { stage, camera } = await room(plan([fixed("out", 0, 1, [2, 1.5, -1]), fixed("in", 2, 4, [1, 1.5, 1])]));
    const facts = (globalThis as any).window.__critic as any[];
    stage.update(1 / 60, 0);
    stage.update(0.6, 0.6);
    expect(camera.position.z).toBeGreaterThan(0);
    expect(facts.at(-1).shot).toBe("out");
    expect(facts.at(-1).shot_clamped).toBe(true);
    stage.update(0.6, 1.2);
    expect(facts.at(-1).shot).toBeNull();
    stage.update(1, 2.2);
    expect(facts.at(-1).shot).toBe("in");
    expect(facts.at(-1).shot_clamped).toBe(false);
    expect(typeof facts.at(-1).plan).toBe("string");
  });
  it("inside the room on either side of the pair the point is not moved (no 180-degree side)", async () => {
    for (const p of [[1, 1.5, 1], [3, 1.5, 2.6]] as V3[]) {
      const { stage, camera } = await room(plan([fixed("s", 0, 5, p)]));
      stage.update(1 / 60, 0);
      stage.update(1, 1);
      near(pos(camera), p, 1e-9);
    }
  });
});

describe("bridge: book_end and scene_end", () => {
  it("book_end reaches its handler without an unknown-type warning", () => {
    const warns: string[] = [];
    let n = 0;
    const b = createBridge({ door: () => null }, { post: () => {}, warn: (m) => warns.push(m) }, { book_end: () => void n++ });
    b.handle({ type: "book_end", scene: "x" });
    expect(n).toBe(1);
    expect(warns).toEqual([]);
  });
  it("transition with cause book -> scene_end; without -> not", () => {
    const got: any[] = [];
    const b = createBridge({ door: () => null }, { post: () => {}, warn: () => {} }, { scene_end: (e) => void got.push(e) });
    b.handle({ type: "transition", cause: "book", scene: "s2" });
    expect(got.length).toBe(1);
    b.handle({ type: "transition", to: "kitchen" });
    expect(got.length).toBe(1);
  });
});

describe("record: event fields", () => {
  it("pickEvent keeps beat and drops the rest", () => {
    const e = pickEvent({ type: "line", who: "Mirai", text: "t", audio: "a.wav", dur: 1.5, beat: 3, extra: 1 });
    expect(e).toEqual({ type: "line", who: "Mirai", text: "t", audio: "a.wav", dur: 1.5, beat: 3 });
    expect("extra" in e).toBe(false);
  });
});
