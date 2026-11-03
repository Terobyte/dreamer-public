/** Squidward, Nov 3 (v6 18–36 s): the frame kept for SpongeBob's line had Squidward's head at ndc x 1.1–1.37, half a
 *  head at the frame's edge; the director checked only the shot's own subjects. Whoever is in the room is in the
 *  frame or out of it, never cut by its edge. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const ROOM: DRoom = { outline: [[0, 0], [6.5, 0], [6.5, 6.5], [0, 6.5]], ceiling: 2.6, open: false };
const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 0, height: 1.8, level: null, room: "r", walking: false, ...o });
const line = (speaker: string): DEvent => ({ kind: "line", speaker, durationS: 3, dt: 0.5, tags: { look: true } });
const narr = (): DEvent => ({ kind: "narrator", durationS: 4, dt: 0.5, tags: {} } as DEvent);
const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
};
/** a head cut by the frame's edge: in front of the lens, past the frame's side by less than a head */
const cut = (a: DActor, cam: [number, number, number], look: [number, number, number], fov: number): boolean => {
  const p = ndcOf(a.head ?? [a.pos[0], a.height * 0.93, a.pos[1]], cam, look, fov, 16 / 9);
  if (p.depth <= 0.2) return false;
  const ax = Math.abs(p.x), ay = Math.abs(p.y);
  return (ax > 0.97 && ax < 1.3 && ay < 1.3) || (ay > 0.97 && ay < 1.3 && ax < 1.3);
};

/** the table and its chairs between them (x -2.7..-0.8, z 0.35..1.4, 1.1 m high) */
const table = (c: [number, number, number], l: [number, number, number]): boolean => {
  for (let i = 1; i < 60; i++) {
    const t = i / 60, x = c[0] + (l[0] - c[0]) * t, y = c[1] + (l[1] - c[1]) * t, z = c[2] + (l[2] - c[2]) * t;
    if (x > -2.7 && x < -0.8 && z > 0.35 && z < 1.4 && y < 1.1) return false;
  }
  return true;
};
// Squidward's living room: a circle of 4.2 m
const ROUND: DRoom = { outline: Array.from({ length: 48 }, (_, i) => [4.2 * Math.sin((i * Math.PI) / 24), 4.2 * Math.cos((i * Math.PI) / 24)] as [number, number]), ceiling: 3.4, open: false };

describe("director: nobody is cut by the frame's edge", () => {
  it("the round room: SpongeBob in by the door, Squidward at the easel, his line and the narration", () => {
    const sponge = act("SpongeBob", [-2.25, 0.11], { yaw: 61.5, height: 1.0, head: [-2.26, 0.57, 0.12] });
    const squid = act("Squidward", [0.73, 2.0], { yaw: 20, height: 1.6, head: [0.75, 1.45, 2.05] });
    const where: string[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng, { style: "storybook" });
      for (const ev of [narr(), line("SpongeBob"), narr(), line("Squidward"), line("SpongeBob"), narr()]) {
        for (let k = 0; k < 8; k++) {
          const out = d.step({ event: k ? { kind: "tick", dt: 0.5 } : ev, actors: [squid, sponge], room: ROUND, rng, clear: table });
          for (const a of [squid, sponge])
            if (cut(a, out.cam, out.look, out.fov ?? 50) && where.length < 8) where.push(`seed ${seed} ${ev.kind}/${k} ${out.plan} ${a.name} ${(out.warnings ?? []).join(",")}`);
        }
      }
    }
    expect(where).toEqual([]);
  }, 240_000);

  it("SpongeBob by the door, Squidward at the easel: every frame has both in or one clearly out", () => {
    const squid = act("Squidward", [4.7, 5.0], { yaw: 200 });
    const sponge = act("SpongeBob", [2.0, 4.1], { yaw: 60, height: 1.0 });
    const where: string[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const rng = seeded(seed);
      const d = createDirector(rng, { style: "storybook" });
      for (const ev of [narr(), line("SpongeBob"), narr(), line("Squidward"), line("SpongeBob"), narr(), line("Squidward")]) {
        for (let k = 0; k < 6; k++) {
          const out = d.step({ event: k ? { kind: "tick", dt: 0.5 } : ev, actors: [squid, sponge], room: ROOM, rng });
          for (const a of [squid, sponge])
            if (cut(a, out.cam, out.look, out.fov ?? 50) && where.length < 6) where.push(`seed ${seed} ${ev.kind} ${out.plan} ${a.name}`);
        }
      }
    }
    expect(where).toEqual([]);
  });
});

import { cleanEdges } from "../src/runtime/stage/director.js";

describe("cleanEdges: the last word on any frame", () => {
  const A = 16 / 9;
  const edge = (h: [number, number, number], o: { cam: any; look: any; fov?: number }) => {
    const p = ndcOf(h, o.cam, o.look, o.fov ?? 50, A);
    return Math.max(Math.abs(p.x), Math.abs(p.y));
  };
  const spongeH: [number, number, number] = [-2.26, 0.57, 0.12], squidH: [number, number, number] = [0.75, 1.45, 2.05];
  const crew = [act("SpongeBob", [-2.25, 0.11], { head: spongeH, height: 1 }), act("Squidward", [0.73, 2], { head: squidH, height: 1.6 })];

  it("v6 30 s: both heads at the edges -> both well inside (wider, re-aimed)", () => {
    const out = { plan: "two", cut: 3, cam: [-1.8, 2.2, 2.7] as any, look: [-0.76, 0.9, 1.05] as any, fov: 50 };
    expect(Math.max(edge(spongeH, out), edge(squidH, out))).toBeGreaterThan(0.97);  // the frame as it was shot
    const o = cleanEdges(out, crew, A);
    expect(edge(spongeH, o)).toBeLessThan(0.9);
    expect(edge(squidH, o)).toBeLessThan(0.9);
    expect(o.cam).toEqual(out.cam);
  });

  it("a close of one with the other's head half in at the side: the other goes out, the subject stays in", () => {
    // camera in front of SpongeBob, Squidward just past the right edge
    const cam: any = [-2.26, 0.6, 1.5], look: any = [-2.26, 0.57, 0.12];
    const side: [number, number, number] = [-1.62, 0.6, 0.6];
    const c2 = [crew[0], act("Squidward", [-1.62, 0.6], { head: side, height: 1.6 })];
    const out = { plan: "close", cut: 1, cam, look, fov: 40 };
    const e0 = edge(side, out);
    expect(e0).toBeGreaterThan(0.97);
    expect(e0).toBeLessThan(1.3);
    const o = cleanEdges(out, c2, A, { maxFov: 40 });
    const e = edge(side, o);
    expect(e < 0.9 || e > 1.3).toBe(true);
    expect(edge(spongeH, o)).toBeLessThan(0.9);
  });

  it("a clean frame comes back as it is", () => {
    const out = { plan: "wide", cut: 1, cam: [-3, 1.6, -3] as any, look: [-0.75, 1, 1.07] as any, fov: 60 };
    expect(cleanEdges(out, crew, A)).toBe(out);
  });

  it("a move with clean ends is left as it is", () => {
    const out = { plan: "wide", cut: 3, cam: [-3, 1.6, -3] as any, look: [-0.75, 1, 1.07] as any, fov: 60, end: [-3.4, 1.6, -3.4] as any, lookEnd: [-0.75, 1, 1.07] as any, move: "pull_out" };
    expect(cleanEdges(out, crew, A)).toBe(out);
  });

  // v16 60–69 s: a push_in over SpongeBob onto Squidward ended with SpongeBob's head on the bottom edge and held there
  // nine seconds; the end frame of a move gets the same last word (its look and fov, never its path)
  it("a move whose end frame cuts a head: the end's look and fov are cleaned", () => {
    const sb: [number, number, number] = [-0.04, 0.59, 2.26], sq: [number, number, number] = [0.7, 1.15, 2.01];
    const c3 = [act("SpongeBob", [-0.04, 2.26], { head: sb, height: 1 }), act("Squidward", [0.73, 2], { head: sq, height: 1.6 })];
    const out = { plan: "ots", cut: 4, cam: [-1.38, 1.25, 2.74] as any, look: sq as any, fov: 50, end: [-0.81, 1.15, 2.54] as any, lookEnd: sq as any, fovEnd: 68, move: "push_in", lookEndRef: { actor: "Squidward", bone: "head", o: [0, 0, 0] } } as any;
    const endOf = (o: any) => ({ cam: o.end, look: o.lookEnd ?? o.look, fov: o.fovEnd ?? o.fov });
    const e0 = edge(sb, endOf(out));
    expect(e0).toBeGreaterThan(0.9);
    expect(e0).toBeLessThan(1.3);
    const o: any = cleanEdges(out, c3, A);
    const e = edge(sb, endOf(o));
    expect(e < 0.9 || e > 1.3).toBe(true);
    expect(edge(sq, endOf(o))).toBeLessThan(0.9);
    expect(o.end).toEqual(out.end);
    expect(o.cam).toEqual(out.cam);
  });
});
