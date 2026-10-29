import { CELL } from "../nav/floor.js";
import type { NavJson } from "../types.js";
import type { V2 } from "../geom/vec.js";

/** A point off the grid is pulled to the nearest walkable cell within this radius (spec "Маршруты"). */
export const SNAP_R = 0.3;

export interface Grid {
  origin: [number, number];
  w: number;
  h: number;
  bits: Uint8Array;
}

export function gridOf(nav: NavJson, level: string): Grid | null {
  const layer = ((nav.layers ?? []) as any[]).find((l) => String(l?.level) === level);
  if (!layer) return null;
  return {
    origin: [Number(layer.origin[0]), Number(layer.origin[1])],
    w: Number(layer.w),
    h: Number(layer.h),
    bits: new Uint8Array(Buffer.from(String(layer.bits ?? ""), "base64")),
  };
}

export function walkable(g: Grid, i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= g.w || j >= g.h) return false;
  const n = j * g.w + i;
  return ((g.bits[n >> 3] >> (n & 7)) & 1) === 1;
}

export function cellOf(g: Grid, p: V2): [number, number] {
  return [Math.floor((p[0] - g.origin[0]) / CELL + 1e-9), Math.floor((p[1] - g.origin[1]) / CELL + 1e-9)];
}

export function cellCenter(g: Grid, i: number, j: number): V2 {
  return [g.origin[0] + (i + 0.5) * CELL, g.origin[1] + (j + 0.5) * CELL];
}

/**
 * The walkable cell nearest to `p` no farther than `radius`, as a cell index,
 * or `null` when the whole disc is solid. Scanning the bounding square of the
 * disc is cheap at 0.04 m cells and keeps the "nearest" rule exact.
 */
export function nearestWalkable(g: Grid, p: V2, radius: number): number | null {
  const [ci, cj] = cellOf(g, p);
  if (walkable(g, ci, cj)) return cj * g.w + ci;
  const r = Math.ceil(radius / CELL) + 1;
  let best: number | null = null;
  let bestD = Infinity;
  for (let j = cj - r; j <= cj + r; j++) {
    for (let i = ci - r; i <= ci + r; i++) {
      if (!walkable(g, i, j)) continue;
      const c = cellCenter(g, i, j);
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (d > radius + 1e-9 || d >= bestD) continue;
      bestD = d;
      best = j * g.w + i;
    }
  }
  return best;
}

/**
 * The walkable cell nearest to `p` anywhere on the grid, ignoring the
 * `SNAP_R`/`PROP_R` reachability radius. Used only to report a `ROUTE_BLOCKED`
 * stuck point that is itself a real nav cell, even when the authored target
 * lies far outside the grid (spec "Маршруты").
 */
export function nearestWalkableAny(g: Grid, p: V2): V2 | null {
  let best: V2 | null = null;
  let bestD = Infinity;
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      if (!walkable(g, i, j)) continue;
      const c = cellCenter(g, i, j);
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (d >= bestD) continue;
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Min-heap over cell indices keyed by f-score. */
class Heap {
  private a: Array<[number, number]> = [];
  get size(): number {
    return this.a.length;
  }
  push(f: number, n: number): void {
    const a = this.a;
    a.push([f, n]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * A* over the nav bits by 8 neighbours. A diagonal step needs both of its
 * orthogonal neighbours walkable: otherwise the capsule would clip the corner
 * of a wall that the inflated grid marks as solid.
 *
 * When the goal is unreachable the answer is not just "no": `stuck` is the
 * reachable cell nearest to `to`, which is what `ROUTE_BLOCKED` reports.
 */
export function findRoute(
  nav: NavJson,
  from: V2,
  to: V2,
  level: string,
): { ok: true; path: V2[] } | { ok: false; stuck: V2 } {
  const g = gridOf(nav, level);
  if (!g) return { ok: false, stuck: from };
  const start = nearestWalkable(g, from, SNAP_R);
  if (start === null) return { ok: false, stuck: from };
  const goal = nearestWalkable(g, to, SNAP_R);

  const n = g.w * g.h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const hOf = (c: number): number => {
    const i = c % g.w;
    const j = (c - i) / g.w;
    const p = cellCenter(g, i, j);
    return Math.hypot(p[0] - to[0], p[1] - to[1]);
  };
  dist[start] = 0;
  const open = new Heap();
  open.push(hOf(start), start);
  let bestStuck = start;
  let bestStuckH = hOf(start);

  while (open.size > 0) {
    const [, c] = open.pop();
    if (done[c]) continue;
    done[c] = 1;
    const hc = hOf(c);
    if (hc < bestStuckH) {
      bestStuckH = hc;
      bestStuck = c;
    }
    if (goal !== null && c === goal) {
      const path: V2[] = [];
      for (let k: number = c; k >= 0; k = prev[k]) {
        const i = k % g.w;
        path.push(cellCenter(g, i, (k - i) / g.w));
      }
      path.reverse();
      return { ok: true, path };
    }
    const ci = c % g.w;
    const cj = (c - ci) / g.w;
    for (const [di, dj] of DIRS) {
      const ni = ci + di;
      const nj = cj + dj;
      if (!walkable(g, ni, nj)) continue;
      if (di !== 0 && dj !== 0 && (!walkable(g, ci + di, cj) || !walkable(g, ci, cj + dj))) continue;
      const m = nj * g.w + ni;
      if (done[m]) continue;
      const step = di !== 0 && dj !== 0 ? Math.SQRT2 * CELL : CELL;
      const nd = dist[c] + step;
      if (nd >= dist[m]) continue;
      dist[m] = nd;
      prev[m] = c;
      open.push(nd + hOf(m), m);
    }
  }

  const si = bestStuck % g.w;
  return { ok: false, stuck: cellCenter(g, si, (bestStuck - si) / g.w) };
}
