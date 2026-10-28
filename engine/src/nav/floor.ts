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
  const p: V2 = [x, z];
  let best: number | null = null;
  for (const r of rooms) {
    if (!pointInPoly(p, r.outline)) continue;
    const y = levelY(ctx, r.level);
    if (y < yPrev - 0.5 || y > yPrev + STEP_MAX) continue;
    if (best === null || Math.abs(y - yPrev) < Math.abs(best - yPrev)) best = y;
  }
  return best;
}
