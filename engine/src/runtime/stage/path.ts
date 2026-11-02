import { CELL, navBit, rampExit, type NavLayer, type NavRamp } from "../../nav/floor.js";
import type { V2 } from "./places.js";

export interface PathOpts {
  /** [minx, minz, maxx, maxz] rects of solid places with their level (null = every level); one holding the start or the goal is ignored */
  obstacles?: Array<{ level: string | null; rect: number[] | null | undefined } | null | undefined>;
  /** level -> nav cell indices (`nav.doors[id].cells`) of open doors there: walkable even if the bitmap says no. Indices are per layer (F25). */
  openCells?: Record<string, number[]>;
}

/** BFS over the nav bitmap (8 neighbours, no corner cutting); -> one waypoint per cell (no thinning: a thinned diagonal can cut a wall, F37), ending on the goal cell, or null. */
export function findPath(layer: NavLayer, bits: Uint8Array, from: V2, to: V2, opts: PathOpts = {}): V2[] | null {
  const { w, h } = layer;
  const cellOf = (p: V2): [number, number] => [
    Math.floor((p[0] - layer.origin[0]) / CELL + 1e-9),
    Math.floor((p[1] - layer.origin[1]) / CELL + 1e-9),
  ];
  const centre = (i: number, j: number): V2 => [layer.origin[0] + (i + 0.5) * CELL, layer.origin[1] + (j + 0.5) * CELL];
  const inside = (r: number[], p: V2): boolean => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  const lvl = String((layer as { level?: unknown }).level ?? "");
  const rects = (opts.obstacles ?? [])
    .filter((o) => !!o && (o.level === null || o.level === undefined || o.level === lvl))
    .map((o) => o!.rect)
    .filter((r): r is number[] => !!r && !inside(r, from) && !inside(r, to));
  const open = new Set(opts.openCells?.[lvl] ?? []);
  const walk = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    if (!open.has(j * w + i) && !navBit(layer, bits, layer.origin[0] + (i + 0.5) * CELL, layer.origin[1] + (j + 0.5) * CELL)) return false;
    const [x, z] = centre(i, j);
    return !rects.some((r) => inside(r, [x, z]));
  };
  const [si, sj] = cellOf(from);
  const [gi, gj] = cellOf(to);
  // F21: an off-layer start or goal (e.g. a side point of a claimed place
  // outside the nav bitmap) must be unreachable, not an infinite walk
  if (si < 0 || sj < 0 || si >= w || sj >= h) return null;
  if (gi < 0 || gj < 0 || gi >= w || gj >= h) return null;
  const goal = gj * w + gi;
  const prev = new Int32Array(w * h).fill(-2);
  const q: number[] = [sj * w + si];
  prev[sj * w + si] = -1;
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  // the start may stand on a blocked cell (an actor leaving a chair): it is always left
  for (let head = 0; head < q.length && prev[goal] === -2; head++) {
    const n = q[head];
    const i = n % w;
    const j = (n - i) / w;
    for (const [di, dj] of steps) {
      const a = i + di;
      const b = j + dj;
      if (!walk(a, b)) continue;
      if (di !== 0 && dj !== 0 && (!walk(i + di, j) || !walk(i, j + dj))) continue;
      const m = b * w + a;
      if (prev[m] !== -2) continue;
      prev[m] = n;
      q.push(m);
    }
  }
  if (prev[goal] === -2) return null;
  const cells: V2[] = [];
  for (let n = goal; n !== -1; n = prev[n]) cells.push(centre(n % w, Math.floor(n / w)));
  cells.reverse();
  return cells.length > 1 ? cells.slice(1) : [cells[0]];
}

export interface StageLevel {
  layer: NavLayer;
  bits: Uint8Array;
  y: number;
}

export interface StageRoute {
  path: V2[];
  /** floor height at each waypoint: constant on a floor, changes only across a ramp ride (F24) */
  ys: number[];
  /** height of the target level */
  yEnd: number;
}

const EPS_Y = 1e-3;

const levelEntry = (levels: StageLevel[], name: string): StageLevel | null =>
  levels.find((l) => String((l.layer as { level?: unknown }).level ?? "") === name) ?? null;

/**
 * Same level -> findPath. Another level -> ride the level graph: walk to a
 * ramp foot on this level, ride it, walk to the next ramp on that level, and
 * so on until the goal level, then walk to the goal. Candidate level chains
 * go shortest first and every ramp is tried, so a blocked first ramp or a
 * route through an intermediate floor still finds a way. Null when no chain
 * has all legs walkable: the caller leaves the goal alone, never walks
 * straight at it.
 */
export function findStageRoute(
  levels: StageLevel[],
  ramps: NavRamp[],
  from: V2,
  fromLevel: string,
  to: V2,
  toLevel: string,
  opts: PathOpts = {},
): StageRoute | null {
  const a = levelEntry(levels, fromLevel);
  const b = levelEntry(levels, toLevel);
  if (!a || !b) return null;
  if (fromLevel === toLevel) {
    const p = findPath(a.layer, a.bits, from, to, opts);
    return p ? { path: p, ys: p.map(() => a.y), yEnd: a.y } : null;
  }
  const nameOfY = (y: number): string | null => {
    const l = levels.find((q) => Math.abs(q.y - y) < EPS_Y);
    return l ? String((l.layer as { level?: unknown }).level ?? "") : null;
  };
  const lowEnd = (r: NavRamp): V2 => [r.axis.from[0], r.axis.from[1]];
  // F7: one `find` only sees a direct ramp. Ramps link levels into a graph —
  // list every ride out of a level: where to board, where it drops, and the
  // level it drops on.
  interface Ride {
    board: V2;
    alight: V2;
    next: string;
  }
  const ridesFrom = (lvl: string): Ride[] => {
    const y = levelEntry(levels, lvl)?.y;
    if (y === undefined) return [];
    const out: Ride[] = [];
    for (const r of ramps) {
      if (Math.abs(r.y0 - y) < EPS_Y) {
        const next = nameOfY(r.y1);
        if (next !== null && next !== lvl) out.push({ board: lowEnd(r), alight: rampExit(r), next });
      } else if (Math.abs(r.y1 - y) < EPS_Y) {
        const next = nameOfY(r.y0);
        if (next !== null && next !== lvl) out.push({ board: rampExit(r), alight: lowEnd(r), next });
      }
    }
    return out;
  };
  // simple level chains (no floor twice), shortest first
  const chains: Ride[][] = [];
  const queue: Array<{ lvl: string; seen: Set<string>; chain: Ride[] }> = [{ lvl: fromLevel, seen: new Set([fromLevel]), chain: [] }];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.chain.length >= levels.length) continue;
    for (const ride of ridesFrom(cur.lvl)) {
      if (cur.seen.has(ride.next)) continue;
      const chain = [...cur.chain, ride];
      if (ride.next === toLevel) chains.push(chain);
      else queue.push({ lvl: ride.next, seen: new Set([...cur.seen, ride.next]), chain });
    }
  }
  for (const chain of chains) {
    const legs: V2[] = [];
    const ys: number[] = [];
    let cur: V2 = from;
    let lvl = fromLevel;
    let ok = true;
    for (const ride of chain) {
      const leg = findPath(levelEntry(levels, lvl)!.layer, levelEntry(levels, lvl)!.bits, cur, ride.board, opts);
      if (!leg) {
        ok = false;
        break;
      }
      legs.push(...leg);
      ys.push(...leg.map(() => levelEntry(levels, lvl)!.y));
      // the ride itself: board (the leg's last point) -> alight, the only place the height changes
      legs.push(ride.alight);
      ys.push(levelEntry(levels, ride.next)!.y);
      cur = ride.alight;
      lvl = ride.next;
    }
    if (!ok) continue;
    const fin = findPath(b.layer, b.bits, cur, to, opts);
    if (!fin) continue;
    legs.push(...fin);
    ys.push(...fin.map(() => b.y));
    return { path: legs, ys, yEnd: b.y };
  }
  return null;
}

/**
 * Inter-room transitions: exit walks to the room's door and marks offstage;
 * enter positions the actor at the scene room's door and steps inside.
 * No path is built through neighboring rooms.
 */
export function interRoomDoorStep(doorAt: V2, doorYaw: number, stepDist = 1.0): { doorPos: V2; insidePos: V2; yaw: number } {
  const rad = (doorYaw * Math.PI) / 180;
  return {
    doorPos: [doorAt[0], doorAt[1]],
    insidePos: [doorAt[0] + Math.sin(rad) * stepDist, doorAt[1] + Math.cos(rad) * stepDist],
    yaw: doorYaw,
  };
}
