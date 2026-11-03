import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";
import { footprintsOverlap } from "../src/build/slab.js";
import { azToPoint } from "../src/geom/arc.js";
import { makeWalker } from "../src/runtime/walk.js";
import { CELL, floorAtRooms, navBit, type NavLayer, type NavRamp } from "../src/nav/floor.js";
import { buildNav } from "../src/nav/grid.js";
import type { Mesh } from "../src/build/geometry.js";
import { intervalMeshes } from "../src/build/walls.js";
import type { WallRoom } from "../src/build/walls.js";
import type { Interval } from "../src/plan/merge.js";
import type { OpeningGeo } from "../src/openings/resolve.js";

// engine geometry debt (LESSONS L96–L110, specs/tero-engine-phase2-debt.md Д2–Д17)

const demoUrl = new URL("../../specs/examples/demo.scene.json", import.meta.url);

function demo(): any {
  return JSON.parse(readFileSync(demoUrl, "utf-8"));
}

/** is `p` on (within `tol` of) some triangle of `ms` */
function onSurface(ms: Mesh[], p: number[], tol: number): boolean {
  const dot = (x: number[], y: number[]): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  for (const m of ms) {
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => m.positions.slice(m.indices[i + k] * 3, m.indices[i + k] * 3 + 3));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(n[0], n[1], n[2]);
      if (l < 1e-12) continue;
      const nn = n.map((x) => x / l);
      const d = (p[0] - a[0]) * nn[0] + (p[1] - a[1]) * nn[1] + (p[2] - a[2]) * nn[2];
      if (Math.abs(d) > tol) continue;
      const w = [0, 1, 2].map((k) => p[k] - nn[k] * d - a[k]);
      const uu = dot(u, u);
      const uv = dot(u, v);
      const vv = dot(v, v);
      const den = uu * vv - uv * uv;
      if (Math.abs(den) < 1e-12) continue;
      const s = (vv * dot(w, u) - uv * dot(w, v)) / den;
      const t = (uu * dot(w, v) - uv * dot(w, u)) / den;
      if (s >= -1e-6 && t >= -1e-6 && s + t <= 1 + 1e-6) return true;
    }
  }
  return false;
}

const R = 4;
const onCircle = (deg: number): [number, number] => [R * Math.sin((deg * Math.PI) / 180), R * Math.cos((deg * Math.PI) / 180)];

/** a full round room wall starting at azimuth 0, swept either way, with one opening */
function circleWall(sweep: number, o: Partial<OpeningGeo>): Mesh[] {
  const iv = {
    level: "L0",
    from: onCircle(0),
    to: onCircle(0),
    arc: { c: [0, 0], r: R, sweep },
    sides: [{ room: "r1", edge: 0, m: [0, 2 * Math.PI * R] }],
    thickness: 0.2,
  } as unknown as Interval;
  const room: WallRoom = { id: "r1", height: 3, normalIn: [0, -1], wallMaterial: "wall", bands: [] };
  const op = { id: "o", sill: 1, height: 1, ...o } as unknown as OpeningGeo;
  return intervalMeshes(iv, { levelY: 0, openings: [op], caps: { k: 0 }, room: () => room }, () => 0);
}

const faces = (ms: Mesh[]): Mesh[] => ms.filter((m) => m.kind === "wall" || m.kind === "band");
const centroid = (m: Mesh): number[] => {
  const c = [0, 0, 0];
  const n = m.positions.length / 3;
  for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) c[k] += m.positions[i + k] / n;
  return c;
};

describe("geometry debt", () => {
  for (const sweep of [2 * Math.PI, -2 * Math.PI]) {
    const tag = sweep > 0 ? "+" : "-";

    it(`L96 opening straddling the seam, sweep ${tag}2π`, () => {
      const d = (Math.asin(0.5 / R) * 180) / Math.PI;
      const ms = faces(circleWall(sweep, { ends: [onCircle(-d), onCircle(d)], center: onCircle(0) }));
      const mid = [0, 1.5, R * Math.cos((d * Math.PI) / 180)];
      expect(onSurface(ms, mid, 0.15)).toBe(false);
      expect(onSurface(ms, [mid[0], 0.5, mid[2]], 0.15)).toBe(true);
      // the far side of the circle is untouched
      const far = onCircle(180);
      expect(onSurface(ms, [far[0], 1.5, far[1]], 0.15)).toBe(true);
    });

    it(`L96 opening with one end exactly on the seam, sweep ${tag}2π`, () => {
      const d = (Math.asin(0.5 / R) * 180) / Math.PI;
      for (const ends of [
        [onCircle(0), onCircle(2 * d)],
        [onCircle(-2 * d), onCircle(0)],
      ] as Array<[[number, number], [number, number]]>) {
        const mid = [(ends[0][0] + ends[1][0]) / 2, 1.5, (ends[0][1] + ends[1][1]) / 2];
        const ms = faces(circleWall(sweep, { ends, center: [mid[0], mid[2]] }));
        expect(onSurface(ms, mid, 0.15)).toBe(false);
        expect(onSurface(ms, [mid[0], 0.5, mid[2]], 0.15)).toBe(true);
        const far = onCircle(180);
        expect(onSurface(ms, [far[0], 1.5, far[1]], 0.15)).toBe(true);
        const other = ends[0][0] === 0 ? onCircle(-2 * d) : onCircle(2 * d);
        expect(onSurface(ms, [other[0], 1.5, other[1]], 0.15)).toBe(true);
      }
    });

    it(`L96 opening past half the circle goes the center's way round, sweep ${tag}2π`, () => {
      // ends at 87° and 273°: the span the long way round (via 180°) is more
      // than half, so length alone would wrap it through the seam at 0°
      const ends = [onCircle(87), onCircle(273)] as [[number, number], [number, number]];
      const chordZ = R * Math.cos((87 * Math.PI) / 180);
      const atChord = (y: number): number[] => [0, y, chordZ];
      const viaFar = faces(circleWall(sweep, { ends, center: onCircle(180) }));
      expect(onSurface(viaFar, atChord(1.5), 0.15)).toBe(false);
      expect(onSurface(viaFar, atChord(0.5), 0.15)).toBe(true);
      expect(onSurface(viaFar, [0, 1.5, R], 0.15)).toBe(true);
      const far = onCircle(180);
      expect(onSurface(viaFar, [far[0], 1.5, far[1]], 0.15)).toBe(false);
      // same ends, center at the seam: the hole wraps through 0° instead
      const viaSeam = faces(circleWall(sweep, { ends, center: onCircle(0) }));
      expect(onSurface(viaSeam, atChord(1.5), 0.15)).toBe(false);
      expect(onSurface(viaSeam, [0, 1.5, R], 0.15)).toBe(false);
      expect(onSurface(viaSeam, [far[0], 1.5, far[1]], 0.15)).toBe(true);
    });

    it(`L97 seam reveals sit on the closing chord, sweep ${tag}2π`, () => {
      const d = (Math.asin(0.5 / R) * 180) / Math.PI;
      const center = onCircle(0);
      const rv = circleWall(sweep, { ends: [onCircle(-d), onCircle(d)], center }).filter((m) => m.kind === "reveal");
      const chordZ = R * Math.cos((d * Math.PI) / 180);
      const sill = rv.filter((m) => m.normals[1] > 0.99);
      const head = rv.filter((m) => m.normals[1] < -0.99);
      const jambs = rv.filter((m) => Math.abs(m.normals[1]) < 1e-9);
      expect([sill.length, head.length, jambs.length]).toEqual([1, 1, 2]);
      for (const m of [...sill, ...head]) {
        const c = centroid(m);
        expect(c[0]).toBeCloseTo(0, 6);
        expect(c[2]).toBeCloseTo(chordZ, 6);
        // the reveal is as deep as the wall, across the chord
        const zs = [];
        for (let i = 2; i < m.positions.length; i += 3) zs.push(m.positions[i]);
        expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(0.2, 6);
      }
      for (const j of jambs) {
        const c = centroid(j);
        const toMid = [0 - c[0], chordZ - c[2]];
        expect(j.normals[0] * toMid[0] + j.normals[2] * toMid[1]).toBeGreaterThan(0);
        expect(Math.abs(j.normals[2])).toBeLessThan(1e-9);
      }
    });
  }

  it("L98 every resolved opening carries its own center", () => {
    // the no-center branch of the wrap rule (a tie at exactly half a circle)
    // is reachable only from synthetic OpeningGeo: resolve always sets it
    const { report, ctx } = runCheck(demo());
    expect(report.errors).toEqual([]);
    const ops = (ctx.openings ?? []) as OpeningGeo[];
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      expect(Number.isFinite(o.center[0]) && Number.isFinite(o.center[1])).toBe(true);
    }
  });

  it("L98 an exact half circle goes the center's way round", () => {
    const ends = [onCircle(90), onCircle(270)] as [[number, number], [number, number]];
    const far = onCircle(180);
    const viaFar = faces(circleWall(2 * Math.PI, { ends, center: far }));
    expect(onSurface(viaFar, [far[0], 1.5, far[1]], 0.15)).toBe(false);
    expect(onSurface(viaFar, [0, 1.5, R], 0.15)).toBe(true);
    const viaSeam = faces(circleWall(2 * Math.PI, { ends, center: onCircle(0) }));
    expect(onSurface(viaSeam, [far[0], 1.5, far[1]], 0.15)).toBe(true);
    expect(onSurface(viaSeam, [0, 1.5, R], 0.15)).toBe(false);
  });

  // the demo flight runs from z 11.6 down to z 6 at x 0.95..1.85; the three
  // old lanes sat at x 0.951, 1.4 and 1.849

  it("L102 a slot in to.room between the lanes stops the cut", () => {
    const raw = demo();
    // loft has a 0.35 m slot (x 1.0..1.35) from its far wall down to z 8:
    // no lane crosses it, but there is no slab over that strip of the tread
    raw.rooms[2].shape = [
      [-2, 4],
      [2, 4],
      [2, 10.5],
      [1.35, 10.5],
      [1.35, 8],
      [1.0, 8],
      [1.0, 10.5],
      [-2, 10.5],
    ];
    const { report } = runCheck(raw);
    const up = (report.passport as any).stairs[0];
    const zs = (up.cut as number[][]).map((p) => p[1]);
    expect(Math.min(...zs)).toBeCloseTo(6, 3);
    expect(Math.max(...zs)).toBeCloseTo(8, 3);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
  });

  it("L102 a beam between the lanes is seen", () => {
    const raw = demo();
    // x 1.025..1.275: over the tread, clear of all three lanes
    raw.rooms[1].beams = [{ from: [1.15, 10.7], to: [1.15, 11.1], material: "wood", w: 0.25, h: 0.5 }];
    const { report } = runCheck(raw);
    expect(report.errors.find((i) => i.code === "STAIR_HEADROOM")).toBeDefined();
  });

  // spec "Вырез … там, где просвет < 2.0" is silent on a disjoint footprint;
  // test_stair_notch_stranded_span_in_headroom pins today's rule (stranded
  // piece → STAIR_HEADROOM). A multi-polygon `cut` changes the passport format
  it.skip("L103 every piece of to.room over the flight is cut, not just the one at the exit (needs spec + passport change)", () => {
    const raw = demo();
    raw.rooms[2].shape = [[-2, 4], [2, 4], [2, 12], [-2, 12], [-2, 10], [1.8, 10], [1.8, 8], [-2, 8]];
    const { report } = runCheck(raw);
    const up = (report.passport as any).stairs[0];
    expect(Array.isArray(up.cut[0][0])).toBe(true);
    expect(up.cut).toHaveLength(2);
  });

  // considering the bar height breaks F2/F3 r1–r4 (no rail past a hall wall
  // stub the rail runs 3.6–3.9 m over); the spec does not say which height or level
  it.skip("L104 a low free wall by the flight top does not remove the rail running over it (needs spec decision)", () => {
    const raw = demo();
    // a 1.0 m free wall 0.10 m off the left face, by the top of the flight
    // where the rail bar is ~4 m up
    raw.walls = [{ level: "L0", from: [0.79, 6.2], to: [0.79, 7.0], thickness: 0.12, material: "white", h: 1.0 }];
    const { report, ctx } = runCheck(raw);
    expect(report.errors).toEqual([]);
    expect(buildGeometry(ctx).meshes.some((m) => m.id === "up:rail:left")).toBe(true);
  });

  it("L105 rail threshold: a side needs strictly more than 0.15 m to the wall face", () => {
    // free wall 0.12 thick, flight's left edge at x 0.95: face at x + 0.06
    const railAt = (x: number): boolean => {
      const raw = demo();
      raw.walls = [{ level: "L0", from: [x, 9.0], to: [x, 10.0], thickness: 0.12, material: "white", h: 1.0 }];
      const { report, ctx } = runCheck(raw);
      expect(report.errors).toEqual([]);
      return buildGeometry(ctx).meshes.some((m) => m.id === "up:rail:left");
    };
    expect(railAt(0.735)).toBe(true); // 0.155 m
    expect(railAt(0.74)).toBe(false); // exactly 0.15 m: no rail
  });

  it("L105 a door beside the flight is a wall (lintel), a full-height opening is not", () => {
    // flight moved next to hall's west wall: left edge at x -1.8, ~0.1 m off
    // its face, so the plain wall takes the left rail away
    const railWith = (h: number | null): boolean => {
      const raw = demo();
      raw.stairs[0].from.at = [-1.35, 11.6];
      raw.spawn.at = [-0.5, 5];
      if (h !== null) {
        raw.openings.push({ id: "side", kind: "door", on: { room: "hall", edge: 3, t: 0.475 }, width: 7.4, height: h, sill: 0, outside: { backdrop: "d_sea" } });
      }
      const { report, ctx } = runCheck(raw);
      expect(report.errors).toEqual([]);
      return buildGeometry(ctx).meshes.some((m) => m.id === "up:rail:left");
    };
    expect(railWith(null)).toBe(false);
    expect(railWith(2.1)).toBe(false);
    expect(railWith(3.0)).toBe(true);
  });

  it("L106 a slab over two lower rooms meets each one's ceiling", () => {
    const raw = demo();
    // loft reaches 2 m over living (ceiling 3.4) besides hall (ceiling 3.0)
    raw.rooms[2].shape = [[-2, 2], [2, 2], [2, 10.5], [-2, 10.5]];
    const { report, ctx } = runCheck(raw);
    expect(report.errors).toEqual([]);
    const slabs = buildGeometry(ctx).meshes.filter((m) => m.kind === "slab" && m.room === "loft");
    /** y of the slab's underside over (x, z) */
    const bottomAt = (x: number, z: number): number[] => {
      const ys: number[] = [];
      for (const m of slabs) {
        for (let t = 0; t < m.indices.length; t += 3) {
          const ix = [0, 1, 2].map((k) => m.indices[t + k]);
          if (ix.some((i) => m.normals[i * 3 + 1] > -0.99)) continue;
          const p = ix.map((i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);
          const side = (a: number[], b: number[]): number => (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);
          const d = [side(p[0], p[1]), side(p[1], p[2]), side(p[2], p[0])];
          if (d.every((v) => v >= -1e-9) || d.every((v) => v <= 1e-9)) ys.push(p[0][1]);
        }
      }
      return ys;
    };
    expect(bottomAt(0.3, 8.1)).toEqual([3.0]);
    expect(bottomAt(0.3, 3.1)).toEqual([3.4]);
    // whatever the slab covers, its top is the loft floor
    for (const m of slabs) for (let i = 1; i < m.positions.length; i += 3) expect(m.positions[i]).toBeLessThanOrEqual(3.6 + 1e-9);
  });

  it("L107 a round room's footprint is its built outline, not the true circle", () => {
    // intended: the lower room's ceiling, floor and wall axis are all built
    // on the same 0.25 m tessellation (plan/rooms.ts, walls.ts axisPoly), so
    // a sliver between a chord and the arc has no ceiling under it to meet
    const r = 2;
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / 0.25));
    const outline = Array.from({ length: n }, (_, k) => azToPoint([0, 0], r, (k * 360) / n));
    const half = 180 / n;
    const chord = r * Math.cos((half * Math.PI) / 180);
    // a thin room across the middle of the first chord, from 1 mm past it outwards
    const ux = Math.sin((half * Math.PI) / 180);
    const uz = Math.cos((half * Math.PI) / 180);
    const at = (d: number, t: number): [number, number] => [ux * d + uz * t, uz * d - ux * t];
    const sliver = [at(chord + 1e-3, -0.02), at(r + 1, -0.02), at(r + 1, 0.02), at(chord + 1e-3, 0.02)];
    expect(Math.hypot(...at(chord + 2e-3, 0))).toBeLessThan(r); // inside the true circle
    expect(footprintsOverlap(outline, sliver)).toBe(false);
    // a millimetre deeper than the chord and it counts
    const deeper = [at(chord - 1e-3, -0.02), at(r + 1, -0.02), at(r + 1, 0.02), at(chord - 1e-3, 0.02)];
    expect(footprintsOverlap(outline, deeper)).toBe(true);
  });

  it("L108 on a mezzanine the walker's layer and floor agree: no level hop without a flight", () => {
    // intended: levels join only through flights (nav flood, routes); where
    // the step window would let the floor drop to the other level, the layer
    // (closest y) says the cell is not walkable and the capsule stays put
    const n = Math.round(4 / CELL);
    /** a 4×4 m layer walkable for x > x0 */
    const grid = (level: string, y: number, x0: number): { layer: NavLayer; bits: Uint8Array } => {
      const bits = new Uint8Array(Math.ceil((n * n) / 8));
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if ((i + 0.5) * CELL > x0) bits[(j * n + i) >> 3] |= 1 << ((j * n + i) & 7);
      return { layer: { level, y, origin: [0, 0], w: n, h: n }, bits };
    };
    const l0 = grid("L0", 0, 0);
    const l1 = grid("L1", 0.4, 2);
    const floors = [
      { y: 0, outline: [[0, 0], [4, 0], [4, 4], [0, 4]] as [number, number][] },
      { y: 0.4, outline: [[2, 0], [4, 0], [4, 4], [2, 4]] as [number, number][] },
    ];
    // up on the mezzanine, walking off its edge: the floor 0.4 below is in
    // the step window, the L1 layer is not walkable there
    const up = makeWalker(l1.layer, l1.bits, floors, [2.5, 2], { layers: [l0], ramps: [] });
    expect(up.pos()[1]).toBeCloseTo(0.4 + 1.6, 9);
    for (let k = 0; k < 20; k++) up.tryMove(-0.05, 0);
    expect(up.pos()[0]).toBeGreaterThan(2);
    expect(up.pos()[1]).toBeCloseTo(0.4 + 1.6, 9);
    // down below, walking under it: the L0 floor carries on, no climb to 0.4
    const down = makeWalker(l0.layer, l0.bits, floors, [1, 2], { layers: [l1], ramps: [] });
    for (let k = 0; k < 40; k++) down.tryMove(0.05, 0);
    expect(down.pos()[0]).toBeCloseTo(3, 6);
    expect(down.pos()[1]).toBeCloseTo(1.6, 9);
  });

  it("L109 inside a flight's footprint only the flight is floor, even with headroom under it", () => {
    // spec "Навигация": the level floors under a ramp are ignored. Under the
    // demo flight's top end (z 6.3, tread ~3.4 m up) the hall floor is out of
    // reach; for stacked storeys this is a limit, not a bug
    const { report, ctx } = runCheck(demo());
    expect(report.errors).toEqual([]);
    const nav = buildNav(ctx);
    const floors = buildGeometry(ctx).floors.map((f) => ({ y: f.y, outline: f.outline as [number, number][] }));
    const ramps = nav.ramps as NavRamp[];
    expect(floorAtRooms(floors, 1.4, 6.3, 0, ramps)).toBe(null);
    expect(floorAtRooms(floors, 1.4, 6.3, 0, [])).toBe(0);
    // beside the footprint the hall floor is there as usual
    expect(floorAtRooms(floors, 0.5, 6.3, 0, ramps)).toBe(0);
  });

  it("L110 no walkable cell beside a flight is within the link radius of its foot or exit", () => {
    // the link takes any cell within 0.3 m of the foot (exit) whatever side
    // it comes from, but the side rail strips (solid in nav with or without
    // a rail mesh) and the eroded cut leave only cells in front of the foot
    // and past the exit there: a side approach cannot happen
    for (const width of [0.9, 0.6, 0.5]) {
      for (const rail of [true, false]) {
        const raw = demo();
        raw.stairs[0].width = width;
        raw.stairs[0].rail = rail;
        const { report, ctx } = runCheck(raw);
        expect(report.errors).toEqual([]);
        const nav = buildNav(ctx);
        const r = (nav.ramps as NavRamp[])[0];
        const foot = r.axis.from;
        const exit: [number, number] = [foot[0], foot[1] - r.axis.len]; // dir 180: up is -z
        const sOf = (z: number): number => foot[1] - z;
        const checks: Array<[string, [number, number], (s: number) => boolean]> = [
          ["L0", foot, (sv) => sv > 1e-9],
          ["L1", exit, (sv) => sv < r.axis.len - 1e-9],
        ];
        for (const [level, at, wrongSide] of checks) {
          const layer = (nav.layers as NavLayer[]).find((l) => l.level === level)!;
          const bits = new Uint8Array(Buffer.from(String(layer.bits), "base64"));
          for (let j = 0; j < layer.h; j++) {
            for (let i = 0; i < layer.w; i++) {
              const cx = layer.origin[0] + (i + 0.5) * CELL;
              const cz = layer.origin[1] + (j + 0.5) * CELL;
              if (Math.hypot(cx - at[0], cz - at[1]) > 0.3 || !navBit(layer, bits, cx, cz)) continue;
              expect(wrongSide(sOf(cz)) && Math.abs(cx - foot[0]) > width / 2 - 0.25, `${level} ${width} ${rail} (${cx}, ${cz})`).toBe(false);
            }
          }
        }
      }
    }
  });
});
