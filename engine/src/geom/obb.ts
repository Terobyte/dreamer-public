import { Clipper, FillRule } from "clipper2-ts";
import type { V2 } from "./vec.js";
import { EPS } from "./vec.js";

export interface OBB {
  c: V2;
  /** w/2, d/2 */
  half: [number, number];
  yaw: number;
}

/** Rotate a local offset by yaw (spec "Соглашения": 0 = +Z, 90 = +X). */
export function rotLocal(lx: number, lz: number, yawDeg: number): V2 {
  const t = (yawDeg * Math.PI) / 180;
  const cs = Math.cos(t);
  const sn = Math.sin(t);
  return [lx * cs + lz * sn, -lx * sn + lz * cs];
}

/** 4 corners from local (-w/2, -d/2), winding with A = ½Σ(xᵢzᵢ₊₁ − xᵢ₊₁zᵢ) > 0. */
export function obbCorners(o: OBB): V2[] {
  const [hw, hd] = o.half;
  const local: V2[] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  return local.map((l) => {
    const r = rotLocal(l[0], l[1], o.yaw);
    return [o.c[0] + r[0], o.c[1] + r[1]] as V2;
  });
}

export function obbAabb(o: OBB): [V2, V2] {
  const pts = obbCorners(o);
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  return [
    [Math.min(...xs), Math.min(...zs)],
    [Math.max(...xs), Math.max(...zs)],
  ];
}

function axesOf(o: OBB): V2[] {
  // the box edge normals are its local axes rotated by yaw
  return [rotLocal(1, 0, o.yaw), rotLocal(0, 1, o.yaw)];
}

function project(pts: V2[], ax: V2): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    const d = p[0] * ax[0] + p[1] * ax[1];
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [lo, hi];
}

/** SAT; a shared face or corner is not a hit (overlap must exceed EPS). */
export function obbIntersects(a: OBB, b: OBB): boolean {
  const pa = obbCorners(a);
  const pb = obbCorners(b);
  for (const ax of [...axesOf(a), ...axesOf(b)]) {
    const [a0, a1] = project(pa, ax);
    const [b0, b1] = project(pb, ax);
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    if (overlap <= EPS) return false;
  }
  return true;
}

function toPath(poly: V2[]): Array<{ x: number; y: number }> {
  return poly.map((p) => ({ x: Math.round(p[0] * 1000), y: Math.round(p[1] * 1000) }));
}

/** Footprint overlap with arbitrary polygons, in m² (clipper, mm integers). */
export function obbPolyIntersects(o: OBB, paths: V2[][]): boolean {
  if (paths.length === 0) return false;
  const inter = Clipper.intersect([toPath(obbCorners(o))], paths.map(toPath), FillRule.NonZero);
  let s = 0;
  for (const path of inter) s += Math.abs(Clipper.area(path));
  return s / 1e6 > 1e-6;
}
