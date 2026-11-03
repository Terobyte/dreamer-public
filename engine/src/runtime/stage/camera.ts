import type { V2 } from "./places.js";

export interface Rect {
  minx: number;
  minz: number;
  maxx: number;
  maxz: number;
}
export type V3 = [number, number, number];
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

/** The 180° line: points with `(p - origin) · normal * sign > 0` are on the allowed side. */
export interface CameraSide {
  origin: V2;
  normal: V2;
  sign: 1 | -1;
}
export interface CameraLaw {
  outline: V2[];
  rect: Rect;
  height: number;
  floorY?: number;
  side?: CameraSide;
  /** frame used when no legal point exists (default: the room center) */
  fallback?: V3;
}
const SIDE_EPS = 1e-6;
const sideOf = (s: CameraSide, p: V2): number => ((p[0] - s.origin[0]) * s.normal[0] + (p[1] - s.origin[1]) * s.normal[1]) * s.sign;

/** The one place a camera point is made legal: inside the outline (0.3 m inset), on the required side of the 180° axis
 * (an on-axis point, |dot| < 1e-6, counts as no side and is moved), and at a height in [floorY + 0.3, ceiling - 0.1]
 * (the lower bound wins only when the room is too low for both). The side is re-checked after `snapInside`; an off-side
 * point takes the nearest inside point of the required side, else `law.fallback`, else the room center. */
export function legalCameraPoint(p: V3, law: CameraLaw): V3 {
  const floorY = law.floorY ?? 0;
  const c = clampCamera(p, law.rect, law.height, floorY);
  const y = Math.max(floorY + 0.3, Math.min(c[1], law.height - 0.1));
  const { outline, side } = law;
  const ok = (q: V2): boolean => (outline.length < 3 || insideInset(outline, q)) && (!side || sideOf(side, q) > SIDE_EPS);
  let xz: V2 = [c[0], c[2]];
  if (outline.length >= 3) xz = snapInside(outline, xz, law.rect);
  if (ok(xz)) return [xz[0], y, xz[1]];
  // nearest legal point of the required side (grid search over the rect, 5 cm)
  let best: V2 | null = null;
  let bd = Infinity;
  const r = law.rect;
  for (let x = r.minx; x <= r.maxx + 1e-9; x += 0.05)
    for (let z = r.minz; z <= r.maxz + 1e-9; z += 0.05) {
      const d = (x - c[0]) ** 2 + (z - c[2]) ** 2;
      if (d < bd && ok([x, z])) {
        bd = d;
        best = [x, z];
      }
    }
  if (best) return [best[0], y, best[1]];
  if (law.fallback) return [law.fallback[0], Math.max(floorY + 0.3, Math.min(law.fallback[1], law.height - 0.1)), law.fallback[2]];
  const cx = (r.minx + r.maxx) / 2;
  const cz = (r.minz + r.maxz) / 2;
  if (outline.length >= 3 && !insideInset(outline, [cx, cz], 0)) {
    const sn = snapInside(outline, [cx, cz], roomRect(outline, 0), 0);
    return [sn[0], y, sn[1]];
  }
  return [cx, y, cz];
}

/** an actor's body for the camera: a vertical column from `y0` (feet) to `top` (over the head), radius `r` */
export interface CamBody {
  pos: V2;
  y0: number;
  top: number;
  r: number;
}

/** The camera out of every body (Koshakan meadow, Nov 3: push_in / close ended 0.1–0.4 m from an actor, the frame full
 *  of hair; a close-up of Mirai in Mama's lap stood inside Mama). A camera within `min` of a body steps back along its
 *  look line, flat, 5 cm at a time, at most `cap` m; still inside at the cap -> the cap point. */
export function clearOfBodies(cam: V3, look: V3, bodies: CamBody[], min = 0.35, cap = 4): V3 {
  const inside = (p: V3): boolean =>
    bodies.some((b) => p[1] >= b.y0 - min && p[1] <= b.top + min && Math.hypot(p[0] - b.pos[0], p[2] - b.pos[1]) < b.r + min);
  if (!inside(cam)) return cam;
  let dx = cam[0] - look[0];
  let dz = cam[2] - look[2];
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) [dx, dz] = [1, 0];
  else [dx, dz] = [dx / d, dz / d];
  let p: V3 = cam;
  for (let s = 0.05; s <= cap + 1e-9; s += 0.05) {
    p = [cam[0] + dx * s, cam[1], cam[2] + dz * s];
    if (!inside(p)) return p;
  }
  return p;
}
