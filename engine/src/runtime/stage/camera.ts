import type { V2 } from "./places.js";

export interface Rect {
  minx: number;
  minz: number;
  maxx: number;
  maxz: number;
}
export type V3 = [number, number, number];
export type ShotKind = "wide" | "two" | "close";

export const INSET = 0.3;
export const CEIL_GAP = 0.3;

/** Bounding rectangle of a room outline, shrunk by `inset` on every side. */
export function roomRect(outline: V2[], inset = INSET): Rect {
  const xs = outline.map((p) => p[0]);
  const zs = outline.map((p) => p[1]);
  return {
    minx: Math.min(...xs) + inset,
    minz: Math.min(...zs) + inset,
    maxx: Math.max(...xs) - inset,
    maxz: Math.max(...zs) - inset,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, hi < lo ? (lo + hi) / 2 : v));

/** Camera position kept inside the rect and inside the floor's vertical volume. */
export function clampCamera(p: V3, r: Rect, height: number, floorY = 0): V3 {
  const top = height - CEIL_GAP;
  const lo = Math.min(floorY, top);
  return [clamp(p[0], r.minx, r.maxx), Math.max(lo, Math.min(p[1], top)), clamp(p[2], r.minz, r.maxz)];
}

/** Is `p` inside the polygon `outline` and at least `inset` away from every edge? */
export function insideInset(outline: V2[], p: V2, inset = INSET): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, zi] = outline[i];
    const [xj, zj] = outline[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xi - xj;
    const ez = zi - zj;
    const L = ex * ex + ez * ez;
    const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - xj) * ex + (p[1] - zj) * ez) / L)) : 0;
    if (Math.hypot(p[0] - (xj + t * ex), p[1] - (zj + t * ez)) < inset) return false;
  }
  return inside;
}

/** The point nearest to `p` that is inside `outline` with the inset (grid search over the rect, 5 cm); `p` if it already is. */
export function snapInside(outline: V2[], p: V2, r: Rect, inset = INSET): V2 {
  if (insideInset(outline, p, inset)) return p;
  let best: V2 | null = null;
  let bd = Infinity;
  const step = 0.05;
  for (let x = r.minx; x <= r.maxx + 1e-9; x += step)
    for (let z = r.minz; z <= r.maxz + 1e-9; z += step) {
      const d = (x - p[0]) ** 2 + (z - p[1]) ** 2;
      if (d < bd && insideInset(outline, [x, z], inset)) {
        bd = d;
        best = [x, z];
      }
    }
  return best ?? p;
}

export interface ShotActor {
  pos: V2;
  speaking: boolean;
}

/** duo.html's three shots: the whole room, the two together, the speaker close. Always inside the room: inside `outline`
 * with the 0.3 m inset when given (round and concave rooms, F31), else inside the rect. */
export function directShot(kind: ShotKind, actors: ShotActor[], r: Rect, height: number, floorY = 0, outline?: V2[]): { pos: V3; look: V3 } {
  const cx = (r.minx + r.maxx) / 2;
  const cz = (r.minz + r.maxz) / 2;
  const top = height - CEIL_GAP;
  const eye = Math.min(floorY + 1.5, top);
  const mid = (list: ShotActor[]): V2 =>
    list.length ? [list.reduce((s, a) => s + a.pos[0], 0) / list.length, list.reduce((s, a) => s + a.pos[1], 0) / list.length] : [cx, cz];
  let pos: V3;
  let look: V3;
  if (kind === "wide") {
    const m = mid(actors);
    pos = [r.minx, top, r.minz];
    look = [m[0], Math.min(floorY + 1.0, top), m[1]];
  } else if (kind === "two") {
    const m = mid(actors);
    const span = actors.length > 1 ? Math.hypot(actors[0].pos[0] - actors[1].pos[0], actors[0].pos[1] - actors[1].pos[1]) : 1;
    pos = [m[0] - 0.7 * (span + 2), eye, m[1] - 0.7 * (span + 2)];
    look = [m[0], Math.min(floorY + 1.2, top), m[1]];
  } else {
    const s = actors.find((a) => a.speaking) ?? actors[0];
    const at: V2 = s ? s.pos : [cx, cz];
    pos = [at[0] - 1.6, eye, at[1] - 1.6];
    look = [at[0], Math.min(floorY + 1.5, top), at[1]];
  }
  const p = clampCamera(pos, r, height, floorY);
  if (outline && outline.length >= 3) {
    const [sx, sz] = snapInside(outline, [p[0], p[2]], r);
    return { pos: [sx, p[1], sz], look };
  }
  return { pos: p, look };
}
