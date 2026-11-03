import type { V2 } from "./vec.js";
import { EPS } from "./vec.js";

export interface Arc {
  c: V2;
  r: number;
  apex: V2;
  sweep: number;
  len: number;
}

function chordNormal(p0: V2, p1: V2, inward: V2): V2 {
  const d: V2 = [p1[0] - p0[0], p1[1] - p0[1]];
  const l = Math.hypot(d[0], d[1]);
  const left: V2 = [-d[1] / l, d[0] / l];
  const right: V2 = [d[1] / l, -d[0] / l];
  const dl = left[0] * inward[0] + left[1] * inward[1];
  const dr = right[0] * inward[0] + right[1] * inward[1];
  return dl >= dr ? left : right;
}

export function arcFromBulge(p0: V2, p1: V2, b: number, inward: V2): Arc {
  const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const a = d / 2;
  const s = Math.abs(b) * a;
  const R = (a * a + s * s) / (2 * s);
  const n = chordNormal(p0, p1, inward);
  const dir = b > 0 ? [-n[0], -n[1]] : [n[0], n[1]];
  const m: V2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const apex: V2 = [m[0] + dir[0] * s, m[1] + dir[1] * s];
  const c: V2 = [m[0] + dir[0] * (s - R), m[1] + dir[1] * (s - R)];
  const a0 = Math.atan2(p0[0] - c[0], p0[1] - c[1]);
  const a1 = Math.atan2(p1[0] - c[0], p1[1] - c[1]);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const apexAng = Math.atan2(apex[0] - c[0], apex[1] - c[1]);
  const rel = (x: number): number => {
    let r = x - a0;
    while (r > Math.PI) r -= 2 * Math.PI;
    while (r < -Math.PI) r += 2 * Math.PI;
    return r;
  };
  if (Math.abs(rel(sweep)) < EPS || Math.abs(rel(Math.atan2(apex[0] - c[0], apex[1] - c[1]) - 0) - rel(sweep) / 2) > Math.PI) {
    void apexAng;
  }
  // choose sweep sign so arc passes through apex
  const inSweep = (ang: number): boolean => {
    const r = rel(ang);
    if (sweep >= 0) return r >= -EPS && r <= sweep + EPS;
    return r <= EPS && r >= sweep - EPS;
  };
  if (!inSweep(apexAng)) sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
  return { c, r: R, apex, sweep, len: Math.abs(R * sweep) };
}

export function discretizeArc(arc: Arc, p0: V2, p1: V2, maxSeg = 0.25): V2[] {
  const total = Math.abs(arc.r * arc.sweep);
  const n = Math.max(1, Math.ceil(total / maxSeg));
  const out: V2[] = [];
  const a0 = Math.atan2(p0[0] - arc.c[0], p0[1] - arc.c[1]);
  for (let i = 0; i <= n; i++) {
    const ang = a0 + (arc.sweep * i) / n;
    out.push([arc.c[0] + arc.r * Math.sin(ang), arc.c[1] + arc.r * Math.cos(ang)]);
  }
  out[0] = [p0[0], p0[1]];
  out[out.length - 1] = [p1[0], p1[1]];
  return out;
}

export function azToPoint(c: V2, r: number, azDeg: number): V2 {
  const rad = (azDeg * Math.PI) / 180;
  return [c[0] + r * Math.sin(rad), c[1] + r * Math.cos(rad)];
}

/** fraction along an arc of the angle `rel` past its start (`rel` in [0, 2π),
 *  measured like the arc's angles); outside the sweep it snaps to the nearer
 *  end, so the start seam (rel = 0 or ≈ 2π) maps to 0 for either sign of sweep */
export function arcFrac(rel: number, sweep: number): number {
  const TAU = 2 * Math.PI;
  const s = Math.abs(sweep);
  if (s < EPS) return 0;
  const r = sweep >= 0 ? rel : (TAU - rel) % TAU;
  if (r <= s) return r / s;
  return r - s < TAU - r ? 1 : 0;
}
