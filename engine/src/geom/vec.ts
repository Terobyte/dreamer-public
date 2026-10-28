export type V2 = [number, number];

export const EPS = 1e-6;
export const SNAP_EPS = 0.1;

export function sub(a: V2, b: V2): V2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function add(a: V2, b: V2): V2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function scale(a: V2, s: number): V2 {
  return [a[0] * s, a[1] * s];
}

export function len(a: V2): number {
  return Math.hypot(a[0], a[1]);
}

export function dist(a: V2, b: V2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function norm(a: V2): V2 {
  const l = len(a);
  if (l < EPS) return [0, 0];
  return [a[0] / l, a[1] / l];
}

export function mid(a: V2, b: V2): V2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

export function degFromVec(x: number, z: number): number {
  return ((Math.atan2(x, z) * 180) / Math.PI % 360 + 360) % 360;
}
