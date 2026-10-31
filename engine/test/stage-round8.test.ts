import { describe, it, expect } from "vitest";
import { findPath, findStageRoute, type StageLevel } from "../src/runtime/stage/path.js";
import { CELL, type NavLayer, type NavRamp } from "../src/nav/floor.js";
import { createActor } from "../src/runtime/stage/actors.js";
import { directShot, roomRect, insideInset } from "../src/runtime/stage/camera.js";
import { audioUrl } from "../src/runtime/stage/subs.js";
import { createToucher } from "../src/runtime/stage/touch.js";
import type { Place, V2 } from "../src/runtime/stage/places.js";

function level(name: string, y: number, w: number, h: number, blocked: Array<[number, number]> = []): StageLevel {
  const bits = new Uint8Array(Math.ceil((w * h) / 8));
  for (let n = 0; n < w * h; n++) bits[n >> 3] |= 1 << (n & 7);
  for (const [i, j] of blocked) {
    const n = j * w + i;
    bits[n >> 3] &= ~(1 << (n & 7));
  }
  return { layer: { level: name, y, origin: [0, 0], w, h } as unknown as NavLayer, bits, y };
}
const c = (i: number): number => (i + 0.5) * CELL;
const ramp = (y0: number, y1: number): NavRamp => ({ stair: "s", y0, y1, axis: { from: [c(2), c(10)], dir: 90, len: 4 * CELL }, poly: [] });

describe("open door cells and obstacles are per level (F25/F32)", () => {
  it("an open door on L0 does not open the same cell index on L1", () => {
    const l1 = { level: "L1", y: 3, origin: [0, 0] as [number, number], w: 3, h: 1 } as unknown as NavLayer;
    const bits = new Uint8Array([4 + 1]); // cells 0 and 2 walkable, cell 1 a shut door
    expect(findPath(l1, bits, [c(0), c(0)], [c(2), c(0)], { openCells: { L0: [1] } })).toBeNull();
    expect(findPath(l1, bits, [c(0), c(0)], [c(2), c(0)], { openCells: { L1: [1] } })).not.toBeNull();
  });
  it("an obstacle on L0 does not block the same spot on L1", () => {
    const l1 = { level: "L1", y: 3, origin: [0, 0] as [number, number], w: 3, h: 1 } as unknown as NavLayer;
    const bits = new Uint8Array([7]);
    const rect = [c(1) - 0.01, 0, c(1) + 0.01, 0.04];
    expect(findPath(l1, bits, [c(0), c(0)], [c(2), c(0)], { obstacles: [{ level: "L0", rect }] })).not.toBeNull();
    expect(findPath(l1, bits, [c(0), c(0)], [c(2), c(0)], { obstacles: [{ level: "L1", rect }] })).toBeNull();
  });
});

describe("no waypoint segment crosses a wall (F37)", () => {
  it("every step is to a neighbouring walkable cell", () => {
    const w = 30;
    const wall: Array<[number, number]> = [];
    for (let j = 0; j < 26; j++) if (j !== 15) wall.push([15, j]);
    const l = level("L0", 0, w, 30, wall);
    const p = findPath(l.layer, l.bits, [c(5), c(5)], [c(25), c(25)])!;
    expect(p).not.toBeNull();
    let prev: V2 = [c(5), c(5)];
    for (const q of p) {
      expect(Math.hypot(q[0] - prev[0], q[1] - prev[1])).toBeLessThanOrEqual(CELL * Math.SQRT2 + 1e-9);
      const i = Math.floor(q[0] / CELL);
      const j = Math.floor(q[1] / CELL);
      expect(i === 15 && j !== 15 && j < 26).toBe(false);
      prev = q;
    }
  });
});

describe("height changes only on the ramp (F24)", () => {
  it("route heights are the floor heights off the ramp", () => {
    const l0 = level("L0", 0, 20, 20);
    const l1 = level("L1", 3, 20, 20);
    const r = findStageRoute([l0, l1], [ramp(0, 3)], [c(1), c(15)], "L0", [c(15), c(15)], "L1")!;
    expect(r).not.toBeNull();
    expect(r.ys.length).toBe(r.path.length);
    const k = r.ys.findIndex((y) => y === 3);
    expect(k).toBeGreaterThan(0);
    expect(r.ys.slice(0, k).every((y) => y === 0)).toBe(true);
    expect(r.ys.slice(k).every((y) => y === 3)).toBe(true);
  });
  it("the actor keeps the floor height on flat legs", async () => {
    const a = await createActor("t", "invalid://nope.glb", 1.7, [0, 0], 0);
    a.go([[1, 0], [2, 0], [3, 0]], 90, "idle", [0, 3, 3]);
    const seen: Array<[number, number]> = [];
    for (let k = 0; k < 300; k++) {
      a.update(1 / 60, k / 60);
      seen.push([a.pos()[0], a.y()]);
    }
    for (const [x, y] of seen) {
      if (x <= 1) expect(y).toBeCloseTo(0, 6);
      if (x >= 2 - 1e-9) expect(y).toBeCloseTo(3, 6);
    }
    expect(a.y()).toBeCloseTo(3, 6);
  });
});

describe("camera stays in the room outline, not its box (F31)", () => {
  it("L-shaped room: the shot is inside the polygon with the 0.3 m inset", () => {
    const L: V2[] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
    // actors in the foot of the L; a box-clamped camera would land in the missing corner
    const actors = [{ pos: [5, 1] as V2, speaking: false }, { pos: [1, 5] as V2, speaking: true }];
    for (const kind of ["wide", "two", "close"] as const) {
      const s = directShot(kind, actors, roomRect(L), 2.7, 0, L);
      expect(insideInset(L, [s.pos[0], s.pos[2]], 0.3 - 1e-6)).toBe(true);
      expect(s.pos[1]).toBeLessThanOrEqual(2.4 + 1e-9);
    }
  });
});

describe("audio url goes through /out/<profile>/<run>/ (F26)", () => {
  it("builds the served path", () => {
    expect(audioUrl("http://127.0.0.1:8770/", "book/run1", "audio/line_001.wav")).toBe(
      "http://127.0.0.1:8770/out/book/run1/audio/line_001.wav",
    );
    expect(audioUrl("http://h", null, "x.wav")).toBeNull();
  });
});

const PLACES: Place[] = [
  { name: "armchair", id: "a", kind: "sit", room: "r", level: "L0", at: [c(4), c(4)], yaw: 180, look: null, obstacle: null },
  { name: "window", id: "w", kind: "stand", room: "r", level: "L0", at: [c(14), c(4)], yaw: 0, look: null, obstacle: null },
  { name: "closet", id: "k", kind: "stand", room: "r", level: "L0", at: [c(14), c(14)], yaw: 0, look: null, obstacle: null },
  { name: "desk", id: "d", kind: "stand", room: "up", level: "L1", at: [c(15), c(15)], yaw: 0, look: null, obstacle: null },
];
type Fake = { pos(): V2; y(): number; go: (p: V2[], yaw: number, act: string, ys?: number[]) => void; walks: number };
const fake = (at: V2, y = 0): Fake => {
  let p = at;
  let yy = y;
  const f: Fake = {
    pos: () => p,
    y: () => yy,
    walks: 0,
    go(path, _yaw, _a, ys) {
      f.walks++;
      p = path[path.length - 1];
      yy = ys ? ys[ys.length - 1] : yy;
    },
  };
  return f;
};

describe("stage touch handler (F33/F34/F30)", () => {
  it("leaving a place frees it for someone else", () => {
    const l0 = level("L0", 0, 20, 20);
    const A = fake([c(1), c(1)]);
    const B = fake([c(1), c(18)]);
    const claims: Record<string, string> = {};
    const t = createToucher({ places: PLACES, claims, levels: [l0], ramps: [], doors: {}, doorOpen: () => false, actor: (w) => ({ A, B } as any)[w] });
    expect(t.touch("A", "armchair")).toBe("walk");
    expect(t.touch("A", "window")).toBe("walk");
    expect(claims.armchair).toBeUndefined();
    expect(t.touch("B", "armchair")).toBe("walk");
    expect(claims.armchair).toBe("B");
  });
  it("an unreachable place is released by the handler and can be retried", () => {
    const wall: Array<[number, number]> = [];
    for (let j = 0; j < 20; j++) wall.push([10, j]);
    const l0 = level("L0", 0, 20, 20, wall);
    const A = fake([c(1), c(1)]);
    const B = fake([c(12), c(1)]);
    const claims: Record<string, string> = {};
    const t = createToucher({ places: PLACES, claims, levels: [l0], ramps: [], doors: {}, doorOpen: () => false, actor: (w) => ({ A, B } as any)[w] });
    expect(t.touch("A", "window")).toBe("unreachable");
    expect(claims.window).toBeUndefined();
    expect(A.walks).toBe(0);
    expect(t.touch("A", "window")).toBe("unreachable");
    expect(t.touch("B", "window")).toBe("walk");
    expect(claims.window).toBe("B");
  });
  it("a touch mid-ramp waits until the actor stands on a floor", () => {
    const l0 = level("L0", 0, 20, 20);
    const l1 = level("L1", 3, 20, 20);
    let y = 1.5;
    const A = { pos: (): V2 => [c(4), c(10)], y: () => y, go: () => undefined } as any;
    const claims: Record<string, string> = {};
    const t = createToucher({ places: PLACES, claims, levels: [l0, l1], ramps: [ramp(0, 3)], doors: {}, doorOpen: () => false, actor: (w) => (w === "A" ? A : undefined) });
    expect(t.touch("A", "desk")).toBe("queued");
    expect(t.levelOf("A")).toBeNull();
    y = 3;
    expect(t.tick()).toEqual(["walk"]);
    expect(t.levelOf("A")).toBe("L1");
  });
});
