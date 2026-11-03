import { describe, it, expect } from "vitest";
import { buildFence } from "../src/nav/fence.js";
import { CELL } from "../src/nav/floor.js";
import type { NavJson } from "../src/types.js";

function pack(w: number, h: number, ok: (i: number, j: number) => boolean): string {
  const bytes = new Uint8Array(Math.ceil((w * h) / 8));
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++)
      if (ok(i, j)) bytes[(j * w + i) >> 3] |= 1 << ((j * w + i) & 7);
  return Buffer.from(bytes).toString("base64");
}

function room(w: number, h: number, ok: (i: number, j: number) => boolean, extra: Partial<NavJson> = {}): NavJson {
  return { cell: CELL, layers: [{ level: "l0", y: 3, origin: [0, 0], w, h, bits: pack(w, h, ok) }], doors: {}, ramps: [], ...extra };
}

const TOL = 0.04 + 1e-6;

describe("buildFence", () => {
  it("empty room: fence follows the walls, shifted out by insetM, normals face the room", () => {
    const f = buildFence(room(10, 10, () => true), 0.5);
    expect(f.length % 9).toBe(0);
    expect(f.length / 9).toBe(4 * 10 * 2); // 40 edge cells, 2 triangles each
    for (let t = 0; t < f.length; t += 9) {
      const ys = [f[t + 1], f[t + 4], f[t + 7]];
      expect(Math.min(...ys)).toBeCloseTo(3, 5);
      expect(Math.max(...ys)).toBeCloseTo(5, 5);
      const cx = (f[t] + f[t + 3] + f[t + 6]) / 3;
      const cz = (f[t + 2] + f[t + 5] + f[t + 8]) / 3;
      const out = Math.max(Math.abs(cx - 0.2), Math.abs(cz - 0.2));
      expect(Math.abs(out - (0.2 + 0.5))).toBeLessThan(TOL);
      // face normal points toward the room centre
      const ux = f[t + 3] - f[t], uy = f[t + 4] - f[t + 1], uz = f[t + 5] - f[t + 2];
      const vx = f[t + 6] - f[t], vy = f[t + 7] - f[t + 1], vz = f[t + 8] - f[t + 2];
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      expect(n[0] * (0.2 - cx) + n[2] * (0.2 - cz)).toBeGreaterThan(0);
    }
  });

  it("an occupied cell gets a closed fence ring shifted by insetM", () => {
    const N = 60; // 2.4 m room, blocked cell 30,30 spans [1.20, 1.24]
    const f = buildFence(room(N, N, (i, j) => !(i === 30 && j === 30)), 0.5);
    expect(f.length / 9).toBe((4 * N + 4) * 2);
    // ring planes sit insetM inside the blocked side: x/z in {1.24-0.5, 1.20+0.5}
    const xs: number[] = [], zs: number[] = [];
    for (let t = 0; t < f.length; t += 9) {
      const cx = (f[t] + f[t + 3] + f[t + 6]) / 3;
      const cz = (f[t + 2] + f[t + 5] + f[t + 8]) / 3;
      if (cx < 0.5 || cx > 1.9 || cz < 0.5 || cz > 1.9) continue;
      xs.push(cx); zs.push(cz);
    }
    expect(xs.length).toBe(4 * 2 * 3 / 3 * 1); // 4 quads, one centroid per triangle
    expect(Math.min(...xs)).toBeGreaterThan(0.74 - TOL);
    expect(Math.max(...xs)).toBeLessThan(1.7 + TOL);
    expect(Math.min(...zs)).toBeGreaterThan(0.74 - TOL);
    expect(Math.max(...zs)).toBeLessThan(1.7 + TOL);
    expect(xs.some((x) => Math.abs(x - 0.74) < TOL)).toBe(true);
    expect(xs.some((x) => Math.abs(x - 1.7) < TOL)).toBe(true);
  });

  it("door cells count as walkable: no fence across the door", () => {
    const w = 10, h = 10;
    const ok = (i: number, j: number) => !(i === 5 && j >= 2 && j <= 3);
    const closed = buildFence(room(w, h, ok), 0.5);
    const doorCells = [2 * w + 5, 3 * w + 5];
    const open = buildFence(room(w, h, ok, { doors: { d: { level: "l0", cells: doorCells } } }), 0.5);
    expect(open.length).toBeLessThan(closed.length);
    expect(open.length / 9).toBe(4 * 10 * 2);
  });

  it("ramp: only the side strips are fenced, entry and exit stay open", () => {
    const ramp = {
      stair: "s", y0: 0, y1: 2,
      axis: { from: [1, 1], dir: 0, len: 2 },
      poly: [[0.3, 1], [1.7, 1], [1.7, 3], [0.3, 3]],
    };
    const f = buildFence({ layers: [], doors: {}, ramps: [ramp] }, 0.5);
    expect(f.length).toBeGreaterThan(0);
    for (let t = 0; t < f.length; t += 3) {
      expect(f[t + 2]).toBeGreaterThan(1 - TOL);
      expect(f[t + 2]).toBeLessThan(3 + TOL);
    }
  });

  it("ramp with layers at both ends: entry and exit are not closed by the storey fences", () => {
    const ramp = {
      stair: "s", y0: 3, y1: 5,
      axis: { from: [1, 1], dir: 0, len: 2 },
      poly: [[0.3, 1], [1.7, 1], [1.7, 3], [0.3, 3]],
    };
    // lower layer is open only for z < 1.0, upper layer only for z > 3.0: the flight itself is bitmap-blocked
    const lo = room(100, 100, (_i, j) => j * CELL < 1.0, { ramps: [ramp] });
    const up = room(100, 100, (_i, j) => j * CELL >= 3.0, { ramps: [ramp] });
    (up.layers as any[])[0].y = 5;
    const nav = { ...lo, layers: [...(lo.layers as any[]), ...(up.layers as any[])] } as NavJson;
    const f = buildFence(nav, 0.5);
    for (let t = 0; t < f.length; t += 9) {
      const cx = (f[t] + f[t + 3] + f[t + 6]) / 3;
      const cz = (f[t + 2] + f[t + 5] + f[t + 8]) / 3;
      // no wall across the walked strip (x 0.6..1.4) anywhere from entry (z 1) to exit (z 3)
      const acrossStrip = Math.abs(f[t + 2] - f[t + 5]) < 1e-9 && Math.abs(f[t + 2] - f[t + 8]) < 1e-9 && cx > 0.65 && cx < 1.35 && cz > 1.05 && cz < 2.95;
      expect(acrossStrip).toBe(false);
    }
  });

  it("ramp over a layer that blocks the flight's upper part: nothing crosses the walked strip", () => {
    const ramp = {
      stair: "s", y0: 3, y1: 5,
      axis: { from: [1, 1], dir: 0, len: 2 },
      poly: [[0.3, 1], [1.7, 1], [1.7, 3], [0.3, 3]],
    };
    // bitmap blocks z in [1.7, 3.0] (the ramp is walked before the bitmap at runtime)
    const nav = room(100, 100, (_i, j) => !(j * CELL >= 1.7 && j * CELL < 3.0), { ramps: [ramp] });
    const f = buildFence(nav, 0.5);
    for (let t = 0; t < f.length; t += 9) {
      const cx = (f[t] + f[t + 3] + f[t + 6]) / 3;
      const cz = (f[t + 2] + f[t + 5] + f[t + 8]) / 3;
      const crosses = cx > 0.6 && cx < 1.4 && cz > 1.05 && cz < 2.95;
      expect(crosses).toBe(false);
    }
  });

  it("ramp on another storey does not open the bitmap of a layer it cannot reach", () => {
    const ramp = {
      stair: "s", y0: 3, y1: 5,
      axis: { from: [1, 1], dir: 0, len: 2 },
      poly: [[0.3, 1], [1.7, 1], [1.7, 3], [0.3, 3]],
    };
    // layer at y=0, central strip under the ramp is blocked in the bitmap
    const base = room(100, 100, (i, j) => !(i * CELL >= 0.6 && i * CELL < 1.4 && j * CELL >= 1.0 && j * CELL < 3.0), { ramps: [ramp] });
    (base.layers as any[])[0].y = 0;
    const f = buildFence(base, 0.5);
    let low = 0;
    for (let t = 0; t < f.length; t += 9) {
      const cx = (f[t] + f[t + 3] + f[t + 6]) / 3;
      const cz = (f[t + 2] + f[t + 5] + f[t + 8]) / 3;
      const ys = [f[t + 1], f[t + 4], f[t + 7]];
      if (Math.min(...ys) < 0.01 && cx > 0.6 && cx < 1.4 && cz > 1.0 && cz < 3.0) low++;
    }
    expect(low).toBeGreaterThan(0);
  });

  it("occupied block (0.8 m, as a real eroded obstacle): the fence around it has no gap from any direction", () => {
    const N = 80, a = 30, b = 50; // blocked cells 30..49 = [1.20, 2.00) in both axes
    const f = buildFence(room(N, N, (i, j) => !(i >= a && i < b && j >= a && j < b)), 0.5);
    // bottom edges of all panels as xz segments
    const segs: number[][] = [];
    for (let t = 0; t < f.length; t += 9) {
      const p: number[][] = [];
      for (const k of [0, 3, 6]) if (Math.abs(f[t + k + 1] - 3) < 1e-6) p.push([f[t + k], f[t + k + 2]]);
      if (p.length === 2) segs.push([p[0][0], p[0][1], p[1][0], p[1][1]]);
    }
    const hit = (dx: number, dz: number) => segs.some(([x1, z1, x2, z2]) => {
      const cx = 1.6, cz = 1.6; // block centre
      const ex = x2 - x1, ez = z2 - z1;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) return false;
      const t = ((x1 - cx) * ez - (z1 - cz) * ex) / den;
      const u = ((x1 - cx) * dz - (z1 - cz) * dx) / den;
      return t > 0 && u >= -1e-9 && u <= 1 + 1e-9;
    });
    for (let d = 0; d < 360; d += 3) {
      const r = (d * Math.PI) / 180;
      expect(hit(Math.cos(r), Math.sin(r))).toBe(true);
    }
  });
});
