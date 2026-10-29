import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";

export const STEP_MAX = 0.25;
export const CAPSULE_R = 0.25;
export const CAPSULE_H = 1.8;
export const CELL = 0.04;

/** even-odd point-in-polygon on a simple outline */
export function pointInPoly(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1]) {
      const x = xi + ((p[1] - zi) / (zj - zi)) * (xj - xi);
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

export function levelY(ctx: Ctx, level: string): number {
  const l = ((ctx.scene as any).levels ?? []).find((x: any) => String(x?.id) === level);
  return typeof l?.y === "number" ? l.y : 0;
}

/**
 * Nearest floor under (x, z) within [yPrev - 0.5, yPrev + step_max].
 * In phase 1 the only floors are the level planes, so a room's outline
 * carries the level's `y`; ramps arrive with stairs in phase 5.
 */
export function floorAt(ctx: Ctx, x: number, z: number, yPrev: number): number | null {
  const rooms = (ctx.rooms ?? []) as Array<{ level: string; outline: V2[] }>;
  return floorAtRooms(
    rooms.map((r) => ({ y: levelY(ctx, r.level), outline: r.outline })),
    x,
    z,
    yPrev,
  );
}

/** A flight of stairs as navigation sees it: a sloped strip over the plan. */
export interface NavRamp {
  stair: string;
  y0: number;
  y1: number;
  /** foot of the flight, its heading in degrees (0 = +Z, 90 = +X) and its run */
  axis: { from: V2; dir: number; len: number };
  /** the flight footprint, a rectangle `width` across the axis */
  poly: V2[];
}

const REPS = 1e-6;

/** unit plan vector of an angle, scene convention (spec "Соглашения") */
function dirVec(deg: number): V2 {
  const a = (deg * Math.PI) / 180;
  const s = Math.sin(a);
  const c = Math.cos(a);
  return [Math.abs(s) < REPS ? 0 : s, Math.abs(c) < REPS ? 0 : c];
}

/** Unit plan vector of a flight's heading: up the stairs. */
export function rampDir(r: NavRamp): V2 {
  return dirVec(r.axis.dir);
}

/** Head of a flight in plan: where the capsule steps off at the top. */
export function rampExit(r: NavRamp): V2 {
  const d = dirVec(r.axis.dir);
  return [r.axis.from[0] + d[0] * r.axis.len, r.axis.from[1] + d[1] * r.axis.len];
}

export interface RampHit {
  /** along the axis, from its foot */
  s: number;
  /** across the axis, signed */
  t: number;
  /** half width of the flight */
  hw: number;
  /** floor height here: linear in `s` (spec "Навигация") */
  y: number;
}

/**
 * Where (x, z) sits on a ramp, or `null` when it is off it. The half width
 * comes from `poly` rather than a stored number, so the strip and the mesh
 * can never disagree. `s` is taken from the axis instead of a point-in-polygon
 * test: the capsule steps onto the flight exactly on the `s = 0` edge, and a
 * boundary point must not fall through.
 */
export function rampAt(r: NavRamp, x: number, z: number): RampHit | null {
  const d = dirVec(r.axis.dir);
  const px: V2 = [-d[1], d[0]];
  const ox = x - r.axis.from[0];
  const oz = z - r.axis.from[1];
  const s = ox * d[0] + oz * d[1];
  const t = ox * px[0] + oz * px[1];
  let hw = 0;
  for (const p of r.poly) {
    const q = Math.abs((p[0] - r.axis.from[0]) * px[0] + (p[1] - r.axis.from[1]) * px[1]);
    if (q > hw) hw = q;
  }
  if (s < -REPS || s > r.axis.len + REPS || Math.abs(t) > hw + REPS) return null;
  const sc = Math.min(r.axis.len, Math.max(0, s));
  const y = r.axis.len > 0 ? r.y0 + ((r.y1 - r.y0) * sc) / r.axis.len : r.y0;
  return { s, t, hw, y };
}

/**
 * A flight is walked down its middle: the strip is eroded by the capsule
 * radius across the axis only, since its two ends are where the capsule
 * steps on and off.
 */
export function rampWalkable(r: NavRamp, x: number, z: number): boolean {
  const hit = rampAt(r, x, z);
  return hit !== null && Math.abs(hit.t) <= hit.hw - CAPSULE_R + REPS;
}

/**
 * The flight carrying (x, z) for a capsule standing at `yPrev`. Flights may
 * be stacked in plan (one storey above the next), so the first footprint hit
 * is not the answer: of the ramps under the point, the one whose height there
 * is inside the step window `[yPrev - 0.5, yPrev + STEP_MAX]` and closest to
 * `yPrev` wins, ties to the earlier ramp. `inside` says the point is in some
 * footprint at all -- there only a ramp carries a floor, so `ramp: null` with
 * `inside: true` means "no floor here".
 */
export function rampUnder(
  ramps: NavRamp[],
  x: number,
  z: number,
  yPrev: number,
): { inside: boolean; ramp: NavRamp | null; y: number } {
  let inside = false;
  let ramp: NavRamp | null = null;
  let y = NaN;
  for (const r of ramps) {
    const hit = rampAt(r, x, z);
    if (hit === null) continue;
    inside = true;
    // the step window holds on a ramp as well
    if (hit.y < yPrev - 0.5 || hit.y > yPrev + STEP_MAX) continue;
    if (ramp === null || Math.abs(hit.y - yPrev) < Math.abs(y - yPrev)) {
      ramp = r;
      y = hit.y;
    }
  }
  return { inside, ramp, y };
}

/**
 * The same nearest-floor rule over plain floor planes, with no `Ctx`: the
 * page gets this one through the runtime bundle (`geometry.floors`).
 *
 * Inside a ramp footprint only the ramp carries a floor; the level planes it
 * flies over are ignored, or the capsule would snap to the storey below.
 */
export function floorAtRooms(
  floors: Array<{ y: number; outline: V2[] }>,
  x: number,
  z: number,
  yPrev: number,
  ramps?: NavRamp[],
): number | null {
  const on = rampUnder(ramps ?? [], x, z, yPrev);
  if (on.inside) return on.ramp === null ? null : on.y;
  const p: V2 = [x, z];
  let best: number | null = null;
  for (const f of floors) {
    if (!pointInPoly(p, f.outline)) continue;
    const y = f.y;
    if (y < yPrev - 0.5 || y > yPrev + STEP_MAX) continue;
    if (best === null || Math.abs(y - yPrev) < Math.abs(best - yPrev)) best = y;
  }
  return best;
}

export interface NavLayer {
  level: string;
  y: number;
  origin: [number, number];
  w: number;
  h: number;
  bits?: string;
}

/** Is the cell holding (x, z) walkable? Cell index and bit order as in `grid.ts`. */
export function navBit(layer: NavLayer, bytes: Uint8Array, x: number, z: number): boolean {
  const i = Math.floor((x - layer.origin[0]) / CELL + 1e-9);
  const j = Math.floor((z - layer.origin[1]) / CELL + 1e-9);
  if (i < 0 || j < 0 || i >= layer.w || j >= layer.h) return false;
  const n = j * layer.w + i;
  return ((bytes[n >> 3] >> (n & 7)) & 1) === 1;
}
