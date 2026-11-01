import { describe, it, expect } from "vitest";
import { createDirector, fallbackFrame, smoothCam, BANK, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";
import { insideInset } from "../src/runtime/stage/camera.js";

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type P = [number, number];
const rect = (w: number, h: number): P[] => [[0, 0], [w, 0], [w, h], [0, h]];
const Lroom: P[] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
const circle: P[] = Array.from({ length: 32 }, (_, i) => [6 + 6 * Math.cos((i / 32) * 2 * Math.PI), 6 + 6 * Math.sin((i / 32) * 2 * Math.PI)] as P);
const act = (name: string, pos: P, o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 0, height: 1.7, level: null, room: "r", walking: false, ...o });
const line = (speaker: string, shot?: string): DEvent => ({ kind: "line", speaker, durationS: 3, dt: 0, shot });

describe("180 degree rule", () => {
  it("camera stays on one side of the a->b axis over 50 cuts without orbit", () => {
    const rng = seeded(7);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(20, 14), ceiling: 3, open: false };
    const plans = BANK.filter((p) => p !== "orbit");
    const signs: number[] = [];
    for (let i = 0; i < 50; i++) {
      const actors = [act("a", [9, 7], { yaw: 90 }), act("b", [11, 7], { yaw: 270 })];
      const o = d.step({ event: line(i % 2 ? "b" : "a", plans[i % plans.length]), actors, room, rng });
      // axis a->b = (1,0), n = (0,1)
      signs.push(Math.sign(o.cam[2] - 7));
      if (process.env.DBG) console.log('DBG', o.plan, o.cam.join(','));
    }
    expect(new Set(signs).size).toBe(1);
    expect(signs[0]).not.toBe(0);
  });
  it("axis flips only after the actors swap places by more than 90 degrees", () => {
    const rng = seeded(3);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(20, 14), ceiling: 3, open: false };
    const at = (ax: number, bx: number) => [act("a", [ax, 7], { yaw: 90 }), act("b", [bx, 7], { yaw: 270 })];
    const s1 = Math.sign(d.step({ event: line("a", "wide"), actors: at(9, 11), room, rng }).cam[2] - 7);
    const s2 = Math.sign(d.step({ event: line("b", "close"), actors: at(9, 11), room, rng }).cam[2] - 7);
    expect(s2).toBe(s1);
    // small shift: axis turns by well under 90 degrees, the previous side is preserved
    const oKeep = d.step({ event: line("a", "wide"), actors: at(9, 10.5), room, rng });
    expect(Math.sign(oKeep.cam[2] - 7)).toBe(s1);
    // swapped: axis a->b is now (-1,0), n = (0,-1); the side is re-picked toward the room center
    const o = d.step({ event: line("a", "wide"), actors: at(11, 9), room, rng });
    // n = (0,-1): the sign of (cam - m)·n is the chosen side and must be a definite one
    expect(Math.abs(Math.sign((o.cam[2] - 7) * -1))).toBe(1);
    // room center [10,7] == pair midpoint: toCenter = 0 -> side = +1, so (cam - m)·n > 0 -> cam z < 7
    expect(o.cam[2]).toBeLessThan(7);
  });
  it("face cone vs side conflict: side wins, non-orbit never returns opposite", () => {
    const rng = seeded(9);
    const d = createDirector(rng);
    const outline = rect(8, 6);
    // axis a->b = (1,0), n = (0,1), m = [4,3] = room center -> side = +1 -> camera z > 3;
    // a faces -z (yaw 180), so the face cone wants z < 3: incompatible by construction.
    // Contract precedence (F2): the 180° side wins over the ≤60° face cone here — asserted explicitly, not skipped.
    const actors = [act("a", [3, 3], { yaw: 180 }), act("b", [5, 3], { yaw: 0 })];
    for (const shot of ["close", "ots"] as const) {
      const o = d.step({ event: line("a", shot), actors, room: { outline, ceiling: 2.7, open: false }, rng });
      expect(o.plan).not.toBe("orbit");
      expect(o.cam[2] - 3).toBeGreaterThan(0);
      // conflict is real: the face cone (≤60° from -z) is violated on purpose, the side holds
      const dx = o.cam[0] - 3;
      const dz = o.cam[2] - 3;
      const ang = Math.abs(Math.atan2(dx * -1 - 0 * dz, dx * 0 + -1 * dz)) * (180 / Math.PI);
      expect(ang).toBeGreaterThan(60);
    }
  });
  it("no actors: camera inside the outline and within the ceiling", () => {
    const rng = seeded(8);
    const d = createDirector(rng);
    const o = d.step({ event: { kind: "tick", dt: 0.1 }, actors: [], room: { outline: Lroom, ceiling: 2.7, open: false }, rng });
    expect(insideInset(Lroom, [o.cam[0], o.cam[2]], 0.3 - 1e-6)).toBe(true);
    expect(o.cam[1]).toBeLessThanOrEqual(2.7);
    const low = d.step({ event: { kind: "tick", dt: 0.1 }, actors: [], room: { outline: rect(8, 6), ceiling: 1.0, open: false }, rng });
    expect(low.cam[1]).toBeLessThanOrEqual(1.0);
    expect(low.cam.every(Number.isFinite)).toBe(true);
  });
});

describe("camera is always inside the room", () => {
  const rooms: Array<[string, P[], P[]]> = [
    ["rect", rect(8, 6), [[1, 1], [1.8, 1.4]]],
    ["L", Lroom, [[1, 1], [1.6, 2]]],
    ["circle", circle, [[1.5, 6], [2.2, 6.5]]],
  ];
  for (const [name, outline, pos] of rooms)
    it(`${name}: every plan inside with 0.3 m inset`, () => {
      const rng = seeded(11);
      const d = createDirector(rng);
      for (let i = 0; i < 24; i++) {
        const actors = [act("a", pos[0], { yaw: 45 }), act("b", pos[1], { yaw: 225 })];
        const o = d.step({ event: line(i % 2 ? "b" : "a", BANK[i % BANK.length]), actors, room: { outline, ceiling: 2.7, open: false }, rng });
        expect(insideInset(outline, [o.cam[0], o.cam[2]], 0.3 - 1e-6)).toBe(true);
        expect(o.cam[1]).toBeLessThanOrEqual(2.7);
      }
    });
});

describe("fallbackFrame", () => {
  it("is inside the outline with 0.3 m inset for actors at the wall", () => {
    const outline = rect(8, 6);
    const f = fallbackFrame([0.05, 0.05], [4, 3], outline, 0.3, 1.4);
    expect(insideInset(outline, [f[0], f[2]], 0.3)).toBe(true);
    expect(f[1]).toBeCloseTo(1.4);
  });
  it("narrower than 0.6 m -> room center, no throw", () => {
    const outline = rect(10, 0.5);
    const f = fallbackFrame([0.1, 0.1], [5, 0.25], outline, 0.3, 1.4);
    expect([f[0], f[2]]).toEqual([5, 0.25]);
  });
  it("injected snap that finds nothing falls back inside", () => {
    const outline = rect(8, 6);
    const rng = seeded(2);
    const d = createDirector(rng, { snap: (_o, _p, _r) => [-50, -50] });
    for (const shot of BANK) {
      const actors = [act("a", [0.35, 0.35], { yaw: 45 }), act("b", [0.9, 0.4], { yaw: 225 })];
      const o = d.step({ event: line("a", shot), actors, room: { outline, ceiling: 2.7, open: false }, rng });
      expect(insideInset(outline, [o.cam[0], o.cam[2]], 0.3 - 1e-6)).toBe(true);
    }
  });
  it("narrow room through the director does not throw", () => {
    const rng = seeded(2);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(10, 0.5), ceiling: 2.7, open: false };
    for (const shot of BANK) {
      const actors = [act("a", [2, 0.25]), act("b", [3, 0.25])];
      const o = d.step({ event: line("a", shot), actors, room, rng });
      expect(o.cam.every(Number.isFinite)).toBe(true);
      expect(o.cam[0]).toBeCloseTo(5, 6);
      expect(o.cam[2]).toBeCloseTo(0.25, 6);
    }
  });
});

describe("open yard, lone actor, same point, smoothing", () => {
  it("open yard camera <= 3.5 m and inside", () => {
    const rng = seeded(4);
    const d = createDirector(rng);
    const outline = rect(20, 20);
    for (let i = 0; i < 16; i++) {
      const actors = [act("a", [9, 10], { yaw: 90 }), act("b", [11, 10], { yaw: 270 })];
      const o = d.step({ event: line(i % 2 ? "b" : "a", BANK[i % BANK.length]), actors, room: { outline, ceiling: 2.7, open: true }, rng });
      expect(o.cam[1]).toBeLessThanOrEqual(3.5);
      expect(insideInset(outline, [o.cam[0], o.cam[2]], 0.3 - 1e-6)).toBe(true);
    }
  });
  it("one actor: only wide/close/follow", () => {
    const rng = seeded(5);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(10, 10), ceiling: 3, open: false };
    for (let i = 0; i < 40; i++) {
      const o = d.step({ event: line("a"), actors: [act("a", [5, 5])], room, rng });
      expect(["wide", "close", "follow"]).toContain(o.plan);
    }
  });
  it("one actor: every fifth line takes rule 5 narrowed to wide (two/orbit need a listener)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng);
      const room: DRoom = { outline: rect(10, 10), ceiling: 3, open: false };
      const solo = [act("a", [5, 5])];
      for (let i = 1; i <= 4; i++) d.step({ event: line("a", i === 4 ? "close" : undefined), actors: solo, room, rng });
      expect(d.step({ event: line("a"), actors: solo, room, rng }).plan).toBe("wide");
    }
  });
  it("one actor: explicit beat shot outside wide/close/follow is coerced", () => {
    const rng = seeded(5);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(10, 10), ceiling: 3, open: false };
    for (const shot of ["orbit", "dolly", "ots", "two", "low"] as const) {
      const o = d.step({ event: line("a", shot), actors: [act("a", [5, 5], { yaw: 0 })], room, rng });
      expect(["wide", "close", "follow"]).toContain(o.plan);
    }
  });
  it("actors in one point: axis from speaker gaze, camera on the face side", () => {
    const rng = seeded(6);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(10, 10), ceiling: 3, open: false };
    const o = d.step({ event: line("a", "close"), actors: [act("a", [5, 5], { yaw: 90 }), act("b", [5.1, 5], { yaw: 90 })], room, rng });
    expect(Number.isFinite(o.cam[0] + o.cam[2])).toBe(true);
    // gaze is +x: camera within 60 degrees of it
    const dx = o.cam[0] - 5;
    const dz = o.cam[2] - 5;
    expect(Math.abs(Math.atan2(dz, dx)) * (180 / Math.PI)).toBeLessThanOrEqual(60.5);
  });
  it("coincident pair: long-line listener reaction keeps the speaker gaze axis", () => {
    const rng = seeded(12);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(10, 10), ceiling: 3, open: false };
    // same point -> axis from gaze; speaker a yaw 0 -> axis (0,1), n = (-1,0); m = center -> side +1 -> cam x < 5.
    // With the bug the reaction re-derives the axis from the listener (yaw 180): same side value but flipped
    // normal -> cam x > 5. The fixed normal below stays on the speaker gaze, so the flip fails red.
    const actors = [act("a", [5, 5], { yaw: 0 }), act("b", [5, 5], { yaw: 180 })];
    const o1 = d.step({ event: { kind: "line", speaker: "a", durationS: 10, dt: 0, shot: "close" }, actors, room, rng });
    const s1 = Math.sign((o1.cam[0] - 5) * -1 + (o1.cam[2] - 5) * 0);
    expect(s1).toBe(1);
    // 45% of 10 s = 4.5 s: tick 5 s fires the listener reaction (close on b); axis must stay on a's gaze
    const o2 = d.step({ event: { kind: "tick", dt: 5 }, actors, room, rng });
    expect(o2.plan).toBe("close");
    const s2 = Math.sign((o2.cam[0] - 5) * -1 + (o2.cam[2] - 5) * 0);
    expect(s2).toBe(s1);
  });
  it("no actors with 0.4 ceiling stays at/below the ceiling", () => {
    const rng = seeded(13);
    const d = createDirector(rng);
    const o = d.step({ event: { kind: "tick", dt: 0.1 }, actors: [], room: { outline: rect(5, 5), ceiling: 0.4, open: false }, rng });
    expect(o.cam[1]).toBeLessThanOrEqual(0.4);
    expect(o.cam.every(Number.isFinite)).toBe(true);
  });
  it("smoothing: 1 - e^(-4 dt) toward the target; a cut is a jump", () => {
    const outline = rect(20, 20);
    const dt = 0.1;
    const k = 1 - Math.exp(-4 * dt);
    const p = smoothCam([2, 1.5, 2], [12, 1.5, 2], k, outline);
    expect(p[0]).toBeCloseTo(2 + 10 * k, 6);
    expect(insideInset(outline, [p[0], p[2]], 0.3 - 1e-6)).toBe(true);
    const rng = seeded(1);
    const d = createDirector(rng);
    const room: DRoom = { outline, ceiling: 3, open: false };
    const actors = [act("a", [9, 10], { yaw: 90 }), act("b", [11, 10], { yaw: 270 })];
    const c0 = d.step({ event: line("a", "wide"), actors, room, rng }).cut;
    expect(d.step({ event: { kind: "tick", dt: 0.1 }, actors, room, rng }).cut).toBe(c0);
    expect(d.step({ event: line("b", "close"), actors, room, rng }).cut).toBeGreaterThan(c0);
  });
  it("smoothing keeps the 0.3 m inset across the L notch", () => {
    const q = smoothCam([3.7, 1.5, 4.3], [4.3, 1.5, 3.7], 0.25, Lroom);
    expect(insideInset(Lroom, [q[0], q[2]], 0.3 - 1e-6)).toBe(true);
  });
});

describe("blocking F3/F4/F6/F7/F8", () => {
  it("F6 thin L with no actors: camera inside the outline and within the ceiling", () => {
    const rng = seeded(21);
    const d = createDirector(rng);
    const outline: P[] = [[0, 0], [10, 0], [10, 0.4], [0.4, 0.4], [0.4, 10], [0, 10]];
    const o = d.step({ event: { kind: "tick", dt: 0.1 }, actors: [], room: { outline, ceiling: 2.7, open: false }, rng });
    expect(insideInset(outline, [o.cam[0], o.cam[2]], 0)).toBe(true);
    expect(o.cam[1]).toBeLessThanOrEqual(2.7);
    expect(o.cam.every(Number.isFinite)).toBe(true);
  });
  it("F4 swap reselects the side from the room center", () => {
    const rng = seeded(3);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(20, 14), ceiling: 3, open: false };
    d.step({ event: line("a", "wide"), actors: [act("a", [9, 7], { yaw: 90 }), act("b", [11, 7], { yaw: 270 })], room, rng });
    // swapped: axis a->b = (-1,0), n = (0,-1), m = [10,7] = room center -> toCenter = 0 -> side = +1
    const o = d.step({ event: line("a", "wide"), actors: [act("a", [11, 7], { yaw: 90 }), act("b", [9, 7], { yaw: 270 })], room, rng });
    const signed = (o.cam[0] - 10) * 0 + (o.cam[2] - 7) * -1;
    expect(signed).toBeGreaterThan(0);
  });
  it("F8 nonzero turn <= 90 preserves the previous side", () => {
    const rng = seeded(31);
    const d = createDirector(rng);
    const room: DRoom = { outline: rect(20, 14), ceiling: 3, open: false };
    const start = [act("a", [8, 7], { yaw: 90 }), act("b", [10, 7], { yaw: 270 })];
    const o1 = d.step({ event: line("a", "wide"), actors: start, room, rng });
    // axis (1,0), n = (0,1), m = [9,7]: side is +1 by construction
    expect(o1.cam[2] - 7).toBeGreaterThan(0);
    // 45-degree turn, same midpoint [9,7]: fresh pick from the room center would be -1
    const turned = [act("a", [8, 6], { yaw: 90 }), act("b", [10, 8], { yaw: 270 })];
    const n1: P = [-Math.SQRT1_2, Math.SQRT1_2];
    const recalc = (10 - 9) * n1[0] + (7 - 7) * n1[1];
    expect(recalc).toBeLessThan(0);
    const o2 = d.step({ event: line("a", "wide"), actors: turned, room, rng });
    const signed = (o2.cam[0] - 9) * n1[0] + (o2.cam[2] - 7) * n1[1];
    expect(signed).toBeGreaterThan(0);
  });
  it("F7 tangent close: non-orbit camera strictly on the selected side", () => {
    const rng = seeded(9);
    const d = createDirector(rng);
    const outline = rect(8, 6);
    const actors = [act("a", [3.5, 2.1339746], { yaw: 60 }), act("b", [4.5, 3.8660254], { yaw: 240 })];
    const o = d.step({ event: line("a", "close"), actors, room: { outline, ceiling: 2.7, open: false }, rng });
    expect(o.plan).not.toBe("orbit");
    // axis a->b ~ [0.5, 0.866], n = [-0.866, 0.5], m = [4,3] = center -> side = +1
    const n: P = [-0.8660254, 0.5];
    const signed = (o.cam[0] - 4) * n[0] + (o.cam[2] - 3) * n[1];
    expect(signed).toBeGreaterThan(0);
  });
});
