import { CAPSULE_R, CELL, rampDir, rampExit, type NavRamp } from "../nav/floor.js";
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

/**
 * Plan distances closer than this count as a tie: cell centres are built from
 * float sums, so two cells mirror-symmetric about the target rarely come out
 * bit-equal, and without a tolerance the "nearest" cell would hinge on 1e-17
 * of rounding noise instead of a stated rule.
 */
const STUCK_TIE = 1e-9;

/**
 * Whether a cell at plan distance `h` with key `k` beats the current stuck
 * cell (`bestH`, `bestK`): closer wins; a tie goes to the smaller key, so the
 * answer never depends on the order A* pops cells in.
 */
function closerStuck(h: number, k: number, bestH: number, bestK: number): boolean {
  if (h < bestH - STUCK_TIE) return true;
  return h <= bestH + STUCK_TIE && k < bestK;
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
    if (closerStuck(hc, c, bestStuckH, bestStuck)) {
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


/** How close to a flight's foot a route has to get to take it (spec "Навигация"). */
const LINK_R = 0.3;

/** A point on a numbered layer. */
interface Node {
  li: number;
  cell: number;
}

/**
 * The cell a route continues from on the level a flight climbs to: the top
 * tread's exit, or the first walkable cell past it. Same rule as the nav
 * flood's seed, so a route can never take a link the flood could not.
 */
function exitCell(g: Grid, r: NavRamp): number | null {
  const d = rampDir(r);
  const e = rampExit(r);
  const steps = Math.ceil((CAPSULE_R + CELL) / CELL);
  for (let k = 0; k <= steps; k++) {
    const [i, j] = cellOf(g, [e[0] + d[0] * k * CELL, e[1] + d[1] * k * CELL]);
    if (walkable(g, i, j)) return j * g.w + i;
  }
  return null;
}

/**
 * The cell a route continues from on the level a flight descends to: the
 * foot of the flight, or the first walkable cell past it (away from the
 * ramp). Same rule as the nav flood's landing search (grid.ts footSeedCell),
 * so a route down can never be refused over a foot cell the flood itself
 * would have stepped past.
 */
function footCell(g: Grid, r: NavRamp): number | null {
  const d = rampDir(r);
  const f = r.axis.from;
  const steps = Math.ceil((CAPSULE_R + CELL) / CELL);
  for (let k = 0; k <= steps; k++) {
    const [i, j] = cellOf(g, [f[0] - d[0] * k * CELL, f[1] - d[1] * k * CELL]);
    if (walkable(g, i, j)) return j * g.w + i;
  }
  return null;
}

/** A flight as the route graph sees it: foot on one layer, exit on another. */
interface Link {
  from: number;
  to: number;
  foot: V2;
  exit: number;
  cost: number;
}

function linksOf(nav: NavJson, levels: string[], grids: Array<Grid | null>): Link[] {
  const out: Link[] = [];
  const ramps = ((nav.ramps ?? []) as NavRamp[]);
  for (const l of (nav.links ?? []) as any[]) {
    const r = ramps.find((x) => x.stair === String(l?.via));
    if (!r) continue;
    const a = levels.indexOf(String(l?.from));
    const b = levels.indexOf(String(l?.to));
    if (a < 0 || b < 0 || !grids[a] || !grids[b]) continue;
    // a flight is walked in both directions: the two ends swap roles
    const up = exitCell(grids[b]!, r);
    if (up !== null) out.push({ from: a, to: b, foot: r.axis.from, exit: up, cost: r.axis.len });
    const down = footCell(grids[a]!, r);
    if (down !== null) {
      out.push({ from: b, to: a, foot: rampExit(r), exit: down, cost: r.axis.len });
    }
  }
  return out;
}

/**
 * A* across every nav layer. Inside one layer this is `findRoute`'s 8-way
 * walk; between layers the only edges are the authored `links`, taken from
 * any cell within `LINK_R` of the flight's foot (spec "Навигация").
 */
export function findRouteLevels(
  nav: NavJson,
  from: { level: string; at: V2 },
  to: { level: string; at: V2 },
): { ok: true; path: Array<{ level: string; at: V2 }> } | { ok: false; stuck: { level: string; at: V2 } } {
  const levels = ((nav.layers ?? []) as any[]).map((l) => String(l?.level));
  const grids = levels.map((l) => gridOf(nav, l));
  const li0 = levels.indexOf(from.level);
  const li1 = levels.indexOf(to.level);
  const g0 = li0 < 0 ? null : grids[li0];
  if (!g0) return { ok: false, stuck: { level: from.level, at: from.at } };
  const start = nearestWalkable(g0, from.at, SNAP_R);
  if (start === null) return { ok: false, stuck: { level: from.level, at: from.at } };
  const goalGrid = li1 < 0 ? null : grids[li1];
  const goal = goalGrid === null ? null : nearestWalkable(goalGrid, to.at, SNAP_R);

  const links = linksOf(nav, levels, grids);
  const offset: number[] = [];
  let total = 0;
  for (const g of grids) {
    offset.push(total);
    total += g ? g.w * g.h : 0;
  }
  const key = (n: Node): number => offset[n.li] + n.cell;
  const posOf = (n: Node): V2 => {
    const g = grids[n.li]!;
    const i = n.cell % g.w;
    return cellCenter(g, i, (n.cell - i) / g.w);
  };
  /**
   * Plan distance to the target, on any layer: how close a cell got, which is
   * not the same question as the heuristic below. `ROUTE_BLOCKED` has to name
   * a stuck point even when the target layer is never reached at all, and
   * then the nearest reachable cell in plan is the only honest answer.
   */
  const planD = (n: Node): number => {
    const p = posOf(n);
    return Math.hypot(p[0] - to.at[0], p[1] - to.at[1]);
  };
  // the heuristic has to stay admissible across layers, where plan distance
  // says nothing: only the goal layer gets one
  const hOf = (n: Node): number => {
    if (n.li !== li1) return 0;
    return planD(n);
  };

  const dist = new Map<number, number>();
  const prev = new Map<number, Node>();
  const node = new Map<number, Node>();
  const done = new Set<number>();
  const open = new Heap();
  const push = (n: Node, d: number, by: Node | null): void => {
    const k = key(n);
    if (done.has(k) || d >= (dist.get(k) ?? Infinity)) return;
    dist.set(k, d);
    node.set(k, n);
    if (by) prev.set(k, by);
    open.push(d + hOf(n), k);
  };
  const s0: Node = { li: li0, cell: start };
  push(s0, 0, null);
  // the stuck cell is ranked by three keys: a cell on the target layer always
  // beats one off it, then the closest in plan wins, then the smaller
  // (layer, cell) key -- never the order cells were popped in
  let bestStuck = s0;
  let bestStuckOn = li0 === li1;
  let bestStuckH = planD(s0);

  while (open.size > 0) {
    const [, k] = open.pop();
    if (done.has(k)) continue;
    done.add(k);
    const n = node.get(k)!;
    const on = n.li === li1;
    const h = planD(n);
    if ((on && !bestStuckOn) || (on === bestStuckOn && closerStuck(h, k, bestStuckH, key(bestStuck)))) {
      bestStuckOn = on;
      bestStuckH = h;
      bestStuck = n;
    }
    if (goal !== null && n.li === li1 && n.cell === goal) {
      const path: Array<{ level: string; at: V2 }> = [];
      for (let c: Node | undefined = n; c; c = prev.get(key(c))) {
        path.push({ level: levels[c.li], at: posOf(c) });
      }
      path.reverse();
      return { ok: true, path };
    }
    const g = grids[n.li]!;
    const d = dist.get(k)!;
    const ci = n.cell % g.w;
    const cj = (n.cell - ci) / g.w;
    for (const [di, dj] of DIRS) {
      const ni = ci + di;
      const nj = cj + dj;
      if (!walkable(g, ni, nj)) continue;
      if (di !== 0 && dj !== 0 && (!walkable(g, ci + di, cj) || !walkable(g, ci, cj + dj))) continue;
      push({ li: n.li, cell: nj * g.w + ni }, d + (di !== 0 && dj !== 0 ? Math.SQRT2 * CELL : CELL), n);
    }
    const here = posOf(n);
    for (const l of links) {
      if (l.from !== n.li) continue;
      if (Math.hypot(here[0] - l.foot[0], here[1] - l.foot[1]) > LINK_R) continue;
      push({ li: l.to, cell: l.exit }, d + l.cost, n);
    }
  }

  return { ok: false, stuck: { level: levels[bestStuck.li], at: posOf(bestStuck) } };
}
