/** К3м v2, rules 2–8: Spark's choice (moves.json) reaches the director. */
import { describe, it, expect, vi } from "vitest";

// r4: a forced event must not reach pickMove; the spy calls through so every other test sees the real draw
const pickSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/runtime/stage/styles.js", async (orig) => {
  const m: any = await orig();
  return { ...m, pickMove: (...a: any[]) => (pickSpy.calls++, m.pickMove(...a)) };
});
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from "three";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { parseMoves, pickStyle, startStage } from "../src/runtime/stage/index.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const act = (name: string, pos: [number, number], yaw: number, room = "R"): DActor => ({ name, pos, yaw, height: 1.7, level: null, room, walking: false });
const A = [act("Mama", [0, 0], 0), act("Mirai", [0, 1.4], 180)];
const line = (beat: number, over: Record<string, unknown> = {}) => ({ kind: "line" as const, speaker: "Mama", durationS: 4, dt: 1, beat, room: "R", ...over });

describe("forced move (r4)", () => {
  it("r4: a valid forced event never calls pickMove; an own beat does", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    pickSpy.calls = 0;
    d.step({ event: line(2, { tags: { look: true }, forced: { move: "close", subject: { actor: "Mirai" } } }), actors: A, room: ROOM });
    expect(pickSpy.calls).toBe(0);
    d.step({ event: line(3), actors: A, room: ROOM });
    expect(pickSpy.calls).toBeGreaterThan(0);
  });
  it("r4: close on Mirai beats the look tag", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const o = d.step({ event: line(2, { tags: { look: true }, forced: { move: "close", subject: { actor: "Mirai" } } }), actors: A, room: ROOM });
    expect(o.move).toBe("close");
    expect((o.lookRef as any)?.actor).toBe("Mirai");
  });
  it("r4/r8: a scheme id becomes its atom", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const o = d.step({ event: line(2, { forced: { move: "over_the_shoulder", subject: { actor: "Mirai" } } }), actors: A, room: ROOM });
    expect(o.move).toBe("ots");
  });
  it("r4: a record is a static point with MOVE_RECORD_ONLY", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const o = d.step({ event: line(2, { forced: { move: "dutch", subject: { actor: "Mirai" } } }), actors: A, room: ROOM });
    expect(o.warnings).toContain("MOVE_RECORD_ONLY dutch");
    expect(o.end).toBeUndefined();
  });
  it("r4: an actor outside the scene -> own choice and FORCED_FALLBACK", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const o = d.step({ event: line(7, { forced: { move: "close", subject: { actor: "Ghost" } } }), actors: A, room: ROOM });
    expect(o.warnings).toContain("FORCED_FALLBACK B7 close");
    expect(o.move).toBeTruthy();
    expect(o.move).not.toBe("close");
    const own = createDirector(() => 0.5, { style: "storybook" }).step({ event: line(7, { tags: {} }), actors: A, room: ROOM });
    expect(o.move).toBe(own.move);
  });
  it("r4: a forced move replaces a held long-cut plan (spielberg)", () => {
    const d = createDirector(() => 0.5, { style: "spielberg" });
    d.step({ event: line(0), actors: A, room: ROOM });
    const b = d.step({ event: line(1, { speaker: "Mirai", forced: { move: "close", subject: { actor: "Mirai" } } }), actors: A, room: ROOM });
    expect(b.move).toBe("close");
  });
  it("r6: one recorded beat leaves every other beat as without the file (same sequential rng)", () => {
    const seq = [0.03, 0.12, 0.28, 0.45, 0.61, 0.78, 0.92, 0.17, 0.37, 0.56, 0.73, 0.88, 0.22, 0.49, 0.67, 0.81];
    const run = (moves: unknown) => {
      // one shared sequential stream for the whole run: a forced beat must not shift the others
      let k = 0;
      const pm = parseMoves(moves);
      const d = createDirector(() => seq[k++ % seq.length], { style: "storybook" });
      return [0, 1, 2, 3, 4, 5].map((n) => {
        return d.step({ event: line(n, { speaker: n % 2 ? "Mirai" : "Mama", ...(pm.beats[n]?.forced ? { forced: pm.beats[n].forced } : {}) }), actors: A, room: ROOM }).move;
      });
    };
    const base = run(undefined);
    const withFile = run({ version: 1, beats: { "2": { move: "close", subject: { actor: "Mirai" } } } });
    expect(withFile[2]).toBe("close");
    for (const n of [0, 1, 3, 4, 5]) expect(withFile[n]).toBe(base[n]);
  });
});

describe("hold (r5)", () => {
  it("r5: hold on a beat change keeps the plan", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const x = d.step({ event: line(0), actors: A, room: ROOM });
    const y = d.step({ event: line(1, { hold: true }), actors: A, room: ROOM });
    expect(y.cut).toBe(x.cut);
    const d2 = createDirector(() => 0.5, { style: "storybook" });
    const x2 = d2.step({ event: line(0), actors: A, room: ROOM });
    expect(d2.step({ event: line(1), actors: A, room: ROOM }).cut).toBe(x2.cut + 1);
  });
  it("r5: a room change inside the same held beat cuts and warns HOLD_IGNORED", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const x = d.step({ event: line(3), actors: A, room: ROOM });
    const B = A.map((a) => ({ ...a, room: "R2" }));
    const y = d.step({ event: line(3, { hold: true, room: "R2" }), actors: B, room: ROOM });
    expect(y.cut).toBe(x.cut + 1);
    expect(y.warnings).toContain("HOLD_IGNORED B3");
  });
  it("r5: a room change cuts and warns HOLD_IGNORED", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const x = d.step({ event: line(0), actors: A, room: ROOM });
    const B = A.map((a) => ({ ...a, room: "R2" }));
    const y = d.step({ event: line(1, { hold: true, room: "R2" }), actors: B, room: ROOM });
    expect(y.cut).toBe(x.cut + 1);
    expect(y.warnings).toContain("HOLD_IGNORED B1");
  });
});

describe("parseMoves / pickStyle (r2, r3)", () => {
  it("r2: a non-index beat key is dropped", () => {
    expect(Object.keys(parseMoves({ version: 1, beats: { " ": { move: "close", subject: { actor: "A" } }, "": { hold: true } } }).beats)).toHaveLength(0);
  });
  it("r2: bad shape is ignored whole", () => {
    expect(parseMoves({ version: 2, beats: {} }).warnings.length).toBeGreaterThan(0);
    expect(Object.keys(parseMoves({ version: 2, beats: {} }).beats)).toHaveLength(0);
    expect(parseMoves({ version: 1, beats: [] }).warnings.length).toBeGreaterThan(0);
    expect(parseMoves("x").warnings.length).toBeGreaterThan(0);
  });
  it("r2: bad items are dropped one by one", () => {
    const p = parseMoves({ version: 1, beats: {
      "1": { move: "nope", subject: { actor: "A" } },
      "2": { move: "close", subject: { room: true } },
      "3": { move: "oner", subject: { actor: "A" } },
      "4": { move: "close", subject: { actor: "A" } },
      "5": { hold: true },
      "6": { move: "wide", subject: { room: true } },
      "7": { move: "dutch", subject: { pair: ["A", "B"] } },
    } });
    expect(p.warnings).toContain("MOVE_UNKNOWN B1");
    expect(p.warnings).toContain("SUBJECT_INVALID B2");
    expect(p.warnings).toContain("MOVE_UNKNOWN B3");
    expect(Object.keys(p.beats).sort()).toEqual(["4", "5", "6", "7"]);
    expect(p.beats[5]).toEqual({ hold: true });
    expect(p.beats[4]).toEqual({ forced: { move: "close", subject: { actor: "A" } } });
  });
  it("r3: style order moves -> camera_style -> storybook", () => {
    expect(pickStyle("ozu", "anderson")).toBe("ozu");
    expect(pickStyle("nope", "anderson")).toBe("anderson");
    expect(pickStyle(undefined, "anderson")).toBe("anderson");
    expect(pickStyle(undefined, undefined)).toBe("storybook");
    const d = createDirector(() => 0.1, { style: pickStyle("ozu", undefined) });
    for (let i = 0; i < 4; i++) expect(d.step({ event: line(i, { speaker: i % 2 ? "Mama" : "Mirai" }), actors: A, room: ROOM }).end).toBeUndefined();
  });
});

async function stageWith(extra: Record<string, unknown>) {
  const scene = new Scene();
  const ceil = new BufferGeometry();
  ceil.setAttribute("position", new Float32BufferAttribute([0, 2.6, 0, 4, 2.6, 0, 4, 2.6, 3.5, 0, 2.6, 3.5], 3));
  ceil.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
  const m = new Mesh(ceil, new MeshStandardMaterial());
  m.userData.kind = "ceiling";
  scene.add(m);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  const stage = await startStage({
    scene, camera, stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: {}, ...(extra.stage as object) },
    places: [], cast: { Mirai: { glb: "missing.glb", height_m: 1.6 } },
    geo: { spawn: { at: [2, 1.75] }, floors: [{ room: "room", level: null, outline: [[0, 0], [4, 0], [4, 3.5], [0, 3.5]] }], meshes: [] },
    layers: [{ layer: { level: null, y: 0, origin: [0, 0], w: 250, h: 250 }, bits: new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255) }],
    nav: { ramps: [], doors: {} }, doorOpen: () => false, ...extra,
  } as any);
  return { stage, camera };
}

describe("startStage with moves (r8)", () => {
  /** the critic facts as record.mjs writes them: one JSON line per fact, read back from the text */
  const jsonl = async (move: string) => {
    (globalThis as any).window = new EventTarget();
    try {
      const { stage } = await stageWith({ cameraStyle: "storybook", moves: { version: 1, beats: { "1": { move, subject: { actor: "Mirai" } } } } });
      stage.update(1 / 60, 0);
      stage.handlers.line!({ type: "line", who: "Mirai", text: "a", source: "book", beat: 0, dur: 2, look: undefined });
      stage.update(0.6, 0.6);
      const before = ((globalThis as any).window.__critic as any[]).length;
      const cutBefore = Math.max(...((globalThis as any).window.__critic as any[]).map((f) => f.dcut ?? 0));
      stage.handlers.line!({ type: "line", who: "Mirai", text: "hi", source: "book", beat: 1, dur: 2, look: undefined });
      stage.update(0.6, 1.2);
      // write critic.jsonl exactly as bin/record.mjs does, then read the file back
      const facts = (globalThis as any).window.__critic as any[];
      const dir = mkdtempSync(join(tmpdir(), "moves-critic-"));
      writeFileSync(`${dir}/critic.jsonl`, facts.map((f) => JSON.stringify(f)).join("\n") + (facts.length ? "\n" : ""));
      const rows = readFileSync(`${dir}/critic.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      rmSync(dir, { recursive: true });
      // the facts of the forced beat: the director plan that began after the beat-0 line (dcut grew)
      return rows.slice(before).filter((r) => (r.dcut ?? 0) > cutBefore);
    } finally {
      delete (globalThis as any).window;
    }
  };
  it("r8: the JSONL fact of the forced beat carries the forced id", async () => {
    const rows = await jsonl("close");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.move).toBe("close");
  });
  it("r8: a scheme id reaches the JSONL fact of the forced beat as its atom", async () => {
    const rows = await jsonl("over_the_shoulder");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.move).toBe("ots");
  });
});

describe("startStage with moves (r2, r7)", () => {
  it("r2: an unreadable moves path warns", async () => {
    const { stage } = await stageWith({ stage: { moves: "shotplan/moves.json" } });
    expect(stage.warnings()).toContain('stage: moves "shotplan/moves.json" not readable -> director');
  });
  it("r2: a moves file that is not JSON warns and forces nothing", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: any, ...r: any[]) => (String(u).includes("moves.json") ? { ok: true, json: () => Promise.reject(new SyntaxError("bad json")) } : real(u, ...r))) as any;
    try {
      const { stage } = await stageWith({ stage: { moves: "shotplan/moves.json" } });
      expect(stage.warnings()).toContain('stage: moves "shotplan/moves.json" not readable -> director');
      expect(stage.warnings().some((w: string) => w.startsWith("MOVE_UNKNOWN") || w.startsWith("SUBJECT_INVALID"))).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
  it("r2: after a json() error the beat still reaches the director, unforced", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: any, ...r: any[]) => (String(u).includes("moves.json") ? { ok: true, json: () => Promise.reject(new SyntaxError("bad json")) } : real(u, ...r))) as any;
    (globalThis as any).window = new EventTarget();
    try {
      const { stage } = await stageWith({ stage: { moves: "shotplan/moves.json" }, cameraStyle: "storybook" });
      stage.update(1 / 60, 0);
      stage.handlers.line!({ type: "line", who: "Mirai", text: "a", source: "book", beat: 0, dur: 2 });
      stage.update(0.6, 0.6);
      const before = ((globalThis as any).window.__critic as any[]).length;
      const calls = pickSpy.calls;
      stage.handlers.line!({ type: "line", who: "Mirai", text: "hi", source: "book", beat: 1, dur: 2 });
      stage.update(0.6, 1.2);
      const rows = ((globalThis as any).window.__critic as any[]).slice(before);
      expect(rows.length).toBeGreaterThan(0);
      // the director picked the move itself (its own pickMove ran), nothing was forced
      expect(pickSpy.calls).toBeGreaterThan(calls);
      expect(stage.warnings().some((w: string) => w.startsWith("FORCED_FALLBACK"))).toBe(false);
    } finally {
      globalThis.fetch = real;
      delete (globalThis as any).window;
    }
  });
  it("r2: a moves file holding JSON null is read and fails the shape check, not 'not readable'", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: any, ...r: any[]) => (String(u).includes("moves.json") ? { ok: true, json: async () => null } : real(u, ...r))) as any;
    try {
      const { stage } = await stageWith({ stage: { moves: "shotplan/moves.json" } });
      expect(stage.warnings()).not.toContain('stage: moves "shotplan/moves.json" not readable -> director');
      expect(stage.warnings().some((w: string) => w.includes("bad shape"))).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });
  it("r4/r5: a goto alone in its beat carries that beat's forced move to the director", async () => {
    (globalThis as any).window = new EventTarget();
    try {
      const places = [{ name: "desk", at: [3, 2.5], kind: "spot" }];
      const { stage } = await stageWith({ places, cameraStyle: "storybook", moves: { version: 1, beats: { "1": { move: "close", subject: { actor: "Mirai" } } } } });
      stage.update(1 / 60, 0);
      stage.handlers.line!({ type: "line", who: "Mirai", text: "a", source: "book", beat: 0, dur: 2 });
      stage.update(0.6, 0.6);
      const before = ((globalThis as any).window.__critic as any[]).length;
      stage.handlers.stage!({ type: "stage", who: "Mirai", action: "goto", place: "desk", source: "book", beat: 1 } as any);
      stage.update(0.6, 1.2);
      const rows = ((globalThis as any).window.__critic as any[]).slice(before);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.at(-1).move).toBe("close");
    } finally {
      delete (globalThis as any).window;
    }
  });
  it("r2: no moves field warns", async () => {
    const { stage } = await stageWith({});
    expect(stage.warnings()).toContain("stage: no moves -> director");
  });
  it("r2: a ready moves object with a bad item surfaces its warning", async () => {
    const { stage } = await stageWith({ moves: { version: 1, beats: { "3": { move: "nope", subject: { actor: "Mirai" } } } } });
    expect(stage.warnings()).toContain("MOVE_UNKNOWN B3");
  });
  it("r7: a Г8 plan wins over moves", async () => {
    const shot = { name: "A", at: "B1", to: "B1e", from: { pos: [1, 1.5, 1], look: [2, 1, 1.75], fov: 40 }, end: { pos: [3, 1.5, 1], look: [2, 1, 1.75], fov: 30 }, ease: "lin" };
    const moves = { version: 1, beats: { "1": { move: "close", subject: { actor: "Mirai" } } } };
    const { stage, camera } = await stageWith({ plan: { version: 1, scene: "t", shots: [shot] }, moves });
    stage.update(1 / 60, 10);
    stage.handlers.line!({ type: "line", who: "Mirai", text: "hi", source: "book", beat: 1, dur: 2 });
    stage.update(1, 11);
    expect(camera.position.x).toBeCloseTo(2, 2);
    expect(camera.position.y).toBeCloseTo(1.5, 2);
  });
});
