import type { V2 } from "./vec.js";
import { EPS } from "./vec.js";

export function signedArea(poly: V2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function orient(a: V2, b: V2, c: V2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSeg(a: V2, b: V2, p: V2): boolean {
  return (
    Math.min(a[0], b[0]) - EPS <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    Math.min(a[1], b[1]) - EPS <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + EPS
  );
}

export function segInt(p1: V2, p2: V2, p3: V2, p4: V2): boolean {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  if (o1 * o2 < -EPS * EPS && o3 * o4 < -EPS * EPS) return true;
  if (Math.abs(o1) < EPS && onSeg(p1, p2, p3)) return true;
  if (Math.abs(o2) < EPS && onSeg(p1, p2, p4)) return true;
  if (Math.abs(o3) < EPS && onSeg(p3, p4, p1)) return true;
  if (Math.abs(o4) < EPS && onSeg(p3, p4, p2)) return true;
  return false;
}

