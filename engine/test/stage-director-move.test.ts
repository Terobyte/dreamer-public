/** К2: the director with a style returns a move (from/end/ease/...), tags and room changes act. */
import { describe, it, expect } from "vitest";
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from "three";
import { STYLES } from "../src/runtime/stage/styles.js";
import { startStage } from "../src/runtime/stage/index.js";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const act = (name: string, pos: [number, number], yaw: number): DActor => ({ name, pos, yaw, height: 1.7, level: null, room: "R", walking: false });
const A = [act("a", [0, 0], 0), act("b", [0, 1.2], 180)];

describe("director styles", () => {
  it("storybook line gets a move; ozu never an end", () => {
    const sb = createDirector(() => 0.1, { style: "storybook" });
    const o = sb.step({ event: { kind: "line", speaker: "a", durationS: 4, dt: 0 }, actors: A, room: ROOM });
    expect(o.move).toBeTruthy();
    expect(o.end).toBeTruthy();
    const oz = createDirector(() => 0.1, { style: "ozu" });
    for (let i = 0; i < 6; i++) expect(oz.step({ event: { kind: "line", speaker: i % 2 ? "a" : "b", durationS: 4, dt: 1 }, actors: A, room: ROOM }).end).toBeUndefined();
  });
  it("first tag gives master; unknown style falls back with a warning", () => {
    const d = createDirector(() => 0.5, { style: "nope" });
    const o = d.step({ event: { kind: "line", speaker: "a", durationS: 4, dt: 0, tags: { first: true } }, actors: A, room: ROOM });
    expect(o.move).toBe("establishing");
    expect(o.warnings).toContain("STYLE_UNKNOWN nope");
  });
  it("last tag on a tick cuts and pulls out; room change cuts", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const a = d.step({ event: { kind: "line", speaker: "a", durationS: 4, dt: 0, room: "R" }, actors: A, room: ROOM });
    const b = d.step({ event: { kind: "tick", dt: 0, tags: { last: true } }, actors: A, room: ROOM });
    expect(b.cut).toBe(a.cut + 1);
    expect(b.move).toBe("final_pull_out");
    const c = d.step({ event: { kind: "tick", dt: 0.1, room: "R2" }, actors: A, room: ROOM });
    expect(c.cut).toBe(b.cut + 1);
  });
  it("legacy director (no style, no tags) has no move", () => {
    const o = createDirector(() => 0.5).step({ event: { kind: "line", speaker: "a", durationS: 4, dt: 0 }, actors: A, room: ROOM });
    expect(o.move).toBeUndefined();
  });
  it("style.height and style.fov bound the first establishing move", () => {
    const d = createDirector(() => 0.1, { style: "storybook" });
    const o = d.step({ event: { kind: "line", speaker: "a", dt: 0, tags: { first: true } }, actors: A, room: ROOM });
    expect(o.cam[1]).toBeLessThanOrEqual(1.1 + 1e-3);
    expect(o.cam[1]).toBeGreaterThanOrEqual(0.6 - 1e-3);
    expect(o.fov!).toBeGreaterThanOrEqual(38 - 1e-6);
    expect(o.fov!).toBeLessThanOrEqual(50 + 1e-6);
    if (o.end) {
      expect(o.end[1]).toBeLessThanOrEqual(1.1 + 1e-3);
      expect(o.fovEnd!).toBeLessThanOrEqual(50 + 1e-6);
    }
  });
  it("ozu (cut long): alternating 3 s lines stay one plan for >= 6 s", () => {
    const d = createDirector(() => 0.5, { style: "ozu" });
    const x = d.step({ event: { kind: "line", speaker: "a", durationS: 3, dt: 0, beat: 0, room: "R" }, actors: A, room: ROOM });
    const y = d.step({ event: { kind: "line", speaker: "b", durationS: 3, dt: 3, beat: 1, room: "R" }, actors: A, room: ROOM });
    const z = d.step({ event: { kind: "line", speaker: "a", durationS: 3, dt: 3, beat: 2, room: "R" }, actors: A, room: ROOM });
    expect(y.cut).toBe(x.cut);
    expect(z.cut).toBe(x.cut);
    const w = d.step({ event: { kind: "line", speaker: "b", durationS: 3, dt: 3, beat: 3, room: "R" }, actors: A, room: ROOM });
    expect(w.cut).toBe(x.cut + 1);
  });
  it("ozu: the same speaker twice in a row cuts (alternation inside the pair only)", () => {
    const d = createDirector(() => 0.5, { style: "ozu" });
    const x = d.step({ event: { kind: "line", speaker: "a", durationS: 3, dt: 0, beat: 0, room: "R" }, actors: A, room: ROOM });
    const y = d.step({ event: { kind: "line", speaker: "a", durationS: 3, dt: 3, beat: 1, room: "R" }, actors: A, room: ROOM });
    expect(y.cut).toBe(x.cut + 1);
  });
  it("a walk event with enter tag is one cut, framed on the entering actor", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const x = d.step({ event: { kind: "line", speaker: "a", durationS: 3, dt: 0, room: "R" }, actors: A, room: ROOM });
    const w = [act("a", [0, 0], 0), { ...act("b", [0, 2], 180), walking: true, walkLeft: 3 }];
    const y = d.step({ event: { kind: "walk", speaker: "b", dt: 0.1, room: "R", tags: { enter: true } }, actors: w, room: ROOM });
    expect(y.cut - x.cut).toBe(1);
    expect(JSON.stringify(y.lookRef ?? "")).toContain('"b"');
  });
  it("a static plan past 2*asl.max gets a drift (move > 0 styles)", () => {
    const v = [0.9, 0];
    let i = 0;
    const d = createDirector(() => v[i++ % v.length], { style: "fincher" });
    const x = d.step({ event: { kind: "line", speaker: "a", durationS: 10, dt: 0 }, actors: [A[0]], room: ROOM });
    expect(x.end).toBeUndefined();
    let y = x;
    for (let t = 1; t <= 9; t++) y = d.step({ event: { kind: "tick", dt: 1 }, actors: [A[0]], room: ROOM });
    expect(y.move).toBe("drift");
    expect(y.end).toBeTruthy();
  });
});

/** startStage with a director style: the move is applied in update(), the lens is restored when it ends. */
async function styled(style: string, seed = 0) {
  const scene = new Scene();
  const ceil = new BufferGeometry();
  ceil.setAttribute("position", new Float32BufferAttribute([0, 2.6, 0, 4, 2.6, 0, 4, 2.6, 3.5, 0, 2.6, 3.5], 3));
  ceil.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
  const m = new Mesh(ceil, new MeshStandardMaterial());
  m.userData.kind = "ceiling";
  scene.add(m);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  const W = 250, H = 250;
  const stage = await startStage({
    scene, camera, stageUrl: "stage/stage.json", sim: null, cameraStyle: style,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {} },
    places: [], cast: { Mirai: { glb: "missing.glb", height_m: 1.6 } },
    geo: { spawn: { at: [2, 1.75] }, floors: [{ room: "room", level: null, outline: [[0, 0], [4, 0], [4, 3.5], [0, 3.5]] }], meshes: [] },
    layers: [{ layer: { level: null, y: 0, origin: [0, 0], w: W, h: H }, bits: new Uint8Array(Math.ceil((W * H) / 8)).fill(255) }],
    nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  return { stage, camera };
}
const L = (beat: number, dur: number) => ({ type: "line", who: "Mirai", text: "hi", source: "book", beat, dur });

describe("director move at runtime", () => {
  for (const style of ["storybook", "malick", "spielberg"]) {
    it(`${style}: camera stays finite and legal, the lens is back after the move`, async () => {
      const { stage, camera } = await styled(style);
      stage.update(1 / 60, 10);
      stage.handlers.line!(L(1, 4));
      const y: number[] = [];
      for (let t = 10; t <= 11; t += 0.25) {
        stage.update(0.25, t);
        y.push(camera.position.y);
        expect(Number.isFinite(camera.position.x + camera.position.y + camera.position.z)).toBe(true);
        expect(camera.position.y).toBeLessThanOrEqual(2.5 + 1e-3);
      }
      for (let t = 11.25; t <= 15; t += 0.25) stage.update(0.25, t);
      const f0 = camera.fov;
      stage.update(0.25, 15.25);
      stage.update(0.25, 15.5);
      // after the move the lens no longer drifts: it is the original 50 (end move) or the style lens (static plan)
      expect(camera.fov).toBeCloseTo(f0, 6);
      const st = STYLES[style];
      expect(Math.abs(f0 - 50) < 1e-6 || (f0 >= st.fov[0] - 1e-6 && f0 <= st.fov[1] + 1e-6)).toBe(true);
    });
  }
});

describe("director move review fixes", () => {
  it("F32: tick that changes room and ev.room cuts once", () => {
    const a = act("a", [0, 0], 0);
    const d = createDirector(() => 0.5, { style: "storybook" });
    const x = d.step({ event: { kind: "line", speaker: "a", dt: 0, room: "R1" }, actors: [a], room: ROOM });
    const y = d.step({ event: { kind: "tick", dt: 0.1, room: "R2" }, actors: [{ ...a, room: "R2" }], room: ROOM });
    expect(y.cut - x.cut).toBe(1);
  });
  it("F36: unknown style warns even with an explicit shot", () => {
    const d = createDirector(() => 0.5, { style: "bogus" });
    const o = d.step({ event: { kind: "line", speaker: "a", durationS: 4, dt: 0, shot: "close" }, actors: A, room: ROOM });
    expect(o.warnings).toContain("STYLE_UNKNOWN bogus");
  });
  it("F26/F31: an entering walker is followed with an end point", () => {
    const actors: DActor[] = [act("a", [0, 0], 0), { ...act("b", [0, 2], 180), walking: true, walkLeft: 3 }];
    const d = createDirector(() => 0.5, { style: "storybook" });
    const o = d.step({ event: { kind: "walk", speaker: "b", dt: 0.1, room: "R", tags: { enter: true } }, actors, room: ROOM });
    expect(o.move).toBe("follow_side");
    expect(o.end).toBeTruthy();
    expect(o.warnings ?? []).not.toContain("MOVE_STATIC");
    expect((o.lookRef as any)?.actor).toBe("b");
  });
});
