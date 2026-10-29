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

/**
 * The same nearest-floor rule over plain floor planes, with no `Ctx`: the
 * page gets this one through the runtime bundle (`geometry.floors`).
 */
export function floorAtRooms(
  floors: Array<{ y: number; outline: V2[] }>,
  x: number,
  z: number,
  yPrev: number,
): number | null {
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
