import { CELL, STEP_MAX, pointInPoly, rampWalkable, type NavRamp } from "./floor.js";
import type { NavJson } from "../types.js";

/** fence height above the floor, metres (IWSDK capsule is 2.0 m) */
const FENCE_H = 2.0;

const DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function unbase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * One quad per edge between a walkable and a blocked cell: from `y0` up to
 * `y1`, shifted `insetM` into the blocked side, normal toward the walkable one.
 * `(nx, nz)` points from the blocked cell to the walkable one.
 */
function pushQuad(out: number[], ex: number, ez: number, nx: number, nz: number, y0: number, y1: number, insetM: number): void {
  // edge midpoint ex,ez is the cell edge; tangent t = (nz, -nx) gives (t x up) = n
  const px = ex - nx * insetM;
  const pz = ez - nz * insetM;
  const h = CELL / 2;
  const ax = px - nz * h, az = pz + nx * h;
  const bx = px + nz * h, bz = pz - nx * h;
  out.push(ax, y0, az, bx, y0, bz, bx, y1, bz);
  out.push(ax, y0, az, bx, y1, bz, ax, y1, az);
}

/**
 * Walls for the locomotor, built from `nav.json` alone: the border between
 * walkable and blocked cells of every layer, as triangles (9 floats each,
 * world metres). Cells outside a layer's grid are blocked; cells of
 * `nav.doors` are walkable (the leaf closes them). Ramps fence only their
 * side strips (`rampWalkable`), their ends stay open.
 */
export function buildFence(nav: NavJson, insetM: number): Float32Array {
  const out: number[] = [];

  for (const l of (nav.layers ?? []) as any[]) {
    const { w, h } = l as { w: number; h: number };
    const ox = l.origin[0] as number;
    const oz = l.origin[1] as number;
    const bits = unbase64(String(l.bits ?? ""));
    const open = new Uint8Array(w * h);
    for (let n = 0; n < w * h; n++) open[n] = (bits[n >> 3] >> (n & 7)) & 1;
    for (const d of Object.values((nav.doors ?? {}) as Record<string, { level: string; cells: number[] }>)) {
      if (d.level !== l.level) continue;
      for (const n of d.cells) if (n >= 0 && n < w * h) open[n] = 1;
    }
    // the runtime checks ramps before the bitmap: the walked strip is open whatever the bitmap says
    for (const r of (nav.ramps ?? []) as NavRamp[]) {
      // a flight belongs to the storeys at its two ends (a step window), not to every layer under its footprint
      const ly = l.y as number;
      if (Math.abs(r.y0 - ly) > STEP_MAX + 1e-6 && Math.abs(r.y1 - ly) > STEP_MAX + 1e-6) continue;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of r.poly) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      const i0 = Math.max(0, Math.floor((minX - ox) / CELL)), i1 = Math.min(w - 1, Math.ceil((maxX - ox) / CELL));
      const j0 = Math.max(0, Math.floor((minZ - oz) / CELL)), j1 = Math.min(h - 1, Math.ceil((maxZ - oz) / CELL));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++)
          if (rampWalkable(r, ox + (i + 0.5) * CELL, oz + (j + 0.5) * CELL)) open[j * w + i] = 1;
    }
    const y0 = l.y as number;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (!open[j * w + i]) continue;
        for (const [di, dj] of DIRS) {
          const a = i + di, b = j + dj;
          if (a >= 0 && b >= 0 && a < w && b < h && open[b * w + a]) continue;
          const ex = ox + (i + 0.5 + di * 0.5) * CELL;
          const ez = oz + (j + 0.5 + dj * 0.5) * CELL;
          pushQuad(out, ex, ez, -di, -dj, y0, y0 + FENCE_H, insetM);
        }
      }
    }
  }

  for (const r of (nav.ramps ?? []) as NavRamp[]) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of r.poly) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const i0 = Math.floor(minX / CELL), j0 = Math.floor(minZ / CELL);
    const w = Math.ceil(maxX / CELL) - i0, h = Math.ceil(maxZ / CELL) - j0;
    // 0 = outside the footprint, 1 = in it but off the walked strip, 2 = walked
    const kind = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = (i0 + i + 0.5) * CELL, z = (j0 + j + 0.5) * CELL;
        if (!pointInPoly([x, z], r.poly)) continue;
        kind[j * w + i] = rampWalkable(r, x, z) ? 2 : 1;
      }
    }
    const y0 = Math.min(r.y0, r.y1);
    const y1 = Math.max(r.y0, r.y1) + FENCE_H;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (kind[j * w + i] !== 2) continue;
        for (const [di, dj] of DIRS) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= w || b >= h || kind[b * w + a] !== 1) continue;
          const ex = (i0 + i + 0.5 + di * 0.5) * CELL;
          const ez = (j0 + j + 0.5 + dj * 0.5) * CELL;
          pushQuad(out, ex, ez, -di, -dj, y0, y1, insetM);
        }
      }
    }
  }

  return Float32Array.from(out);
}
