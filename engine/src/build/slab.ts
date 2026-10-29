import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import type { Mesh } from "./geometry.js";
import { earClip } from "./floors.js";
import { MeshBuilder } from "./mesh.js";
import type { V3 } from "./mesh.js";

export function signedArea2(poly: V2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

const ccw = (poly: V2[]): V2[] => (signedArea2(poly) < 0 ? [...poly].reverse() : poly);
const cw = (poly: V2[]): V2[] => (signedArea2(poly) > 0 ? [...poly].reverse() : poly);

/** do `a→b` and `c→d` cross away from their endpoints? */
function segsCross(a: V2, b: V2, c: V2, d: V2): boolean {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const cdx = d[0] - c[0];
  const cdz = d[1] - c[1];
  const den = abx * cdz - abz * cdx;
  if (Math.abs(den) < EPS) return false;
  const t = ((c[0] - a[0]) * cdz - (c[1] - a[1]) * cdx) / den;
  const u = ((c[0] - a[0]) * abz - (c[1] - a[1]) * abx) / den;
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS;
}

function inPoly(poly: V2[], p: V2): boolean {
  let hit = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xi, zi] = poly[a];
    const [xj, zj] = poly[b];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Splices `hole` into `outer` with a bridge: two coincident edges run from the
 * rightmost hole vertex to a contour vertex visible from it, so the result is
 * one simple polygon `earClip` can chew on (it knows nothing of holes).
 */
export function bridgeHole(outer: V2[], hole: V2[]): V2[] {
  const o = ccw(outer);
  const h = cw(hole);
  if (h.length < 3 || o.length < 3) return o;
  let iM = 0;
  for (let i = 1; i < h.length; i++) if (h[i][0] > h[iM][0] + EPS) iM = i;
  const m = h[iM];
  const blocked = (p: V2, skipO: number[], skipH: number[]): boolean => {
    for (let i = 0; i < o.length; i++) {
      if (skipO.includes(i)) continue;
      if (segsCross(m, p, o[i], o[(i + 1) % o.length])) return true;
    }
    for (let i = 0; i < h.length; i++) {
      if (skipH.includes(i)) continue;
      if (segsCross(m, p, h[i], h[(i + 1) % h.length])) return true;
    }
    return false;
  };
  const skipH = [iM, (iM + h.length - 1) % h.length];
  let iP = -1;
  let best = Infinity;
  for (let i = 0; i < o.length; i++) {
    const p = o[i];
    const d = Math.hypot(p[0] - m[0], p[1] - m[1]);
    if (d >= best) continue;
    if (blocked(p, [i, (i + o.length - 1) % o.length], skipH)) continue;
    const mid: V2 = [(m[0] + p[0]) / 2, (m[1] + p[1]) / 2];
    if (!inPoly(o, mid) || inPoly(h, mid)) continue;
    iP = i;
    best = d;
  }
  if (iP < 0) return o;
  const ring = [...h.slice(iM), ...h.slice(0, iM)];
  return [...o.slice(0, iP + 1), ...ring, m, o[iP], ...o.slice(iP + 1)];
}

/** the outline with every hole bridged in, as one simple polygon */
export function facePoly(outer: V2[], holes: V2[][]): V2[] {
  let poly = ccw(outer);
  for (const h of holes) poly = bridgeHole(poly, h);
  return poly;
}

/** rings of a face: the outline plus its holes, each oriented solid-on-the-left */
export function faceRings(outer: V2[], holes: V2[][]): V2[][] {
  return [ccw(outer), ...holes.map(cw)];
}

/** A solid slab over `outer` minus `holes`, from `yBot` to `yTop`: caps and sides. */
export function extrudeFace(
  m: Omit<Mesh, "positions" | "normals" | "uvs" | "indices">,
  outer: V2[],
  holes: V2[][],
  yBot: number,
  yTop: number,
): Mesh {
  const mb = new MeshBuilder();
  const poly = facePoly(outer, holes);
  const tris = earClip(poly);
  for (const [y, n] of [
    [yTop, [0, 1, 0] as V3],
    [yBot, [0, -1, 0] as V3],
  ] as Array<[number, V3]>) {
    for (let t = 0; t < tris.length; t += 3) {
      const p = [tris[t], tris[t + 1], tris[t + 2]].map((i) => poly[i]);
      mb.tri(
        [p[0][0], y, p[0][1]],
        [p[1][0], y, p[1][1]],
        [p[2][0], y, p[2][1]],
        n,
        [p[0][0], p[0][1]],
        [p[1][0], p[1][1]],
        [p[2][0], p[2][1]],
      );
    }
  }
  for (const ring of faceRings(outer, holes)) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dx, dz);
      if (l < EPS) continue;
      // the solid lies left of a→b on every ring, so its face looks right
      const n: V3 = [dz / l, 0, -dx / l];
      mb.quad(
        [a[0], yBot, a[1]],
        [b[0], yBot, b[1]],
        [b[0], yTop, b[1]],
        [a[0], yTop, a[1]],
        n,
        [0, 0],
        [l, 0],
        [l, yTop - yBot],
        [0, yTop - yBot],
      );
    }
  }
  return mb.finish(m);
}

function segDist(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

/**
 * Do the interiors of two simple polygons meet, i.e. is their shared area
 * positive? Decided in floating point with no length or area tolerance, so an
 * overlap far below any rounding step still counts and mere touching (a
 * common edge or corner) does not.
 *
 * Every edge of each polygon is split wherever the other polygon's boundary
 * meets it, so each piece borders one face of the overlay on either side.
 * Every face of the overlay has such a piece on its border, so stepping off
 * each piece's midpoint to both sides — by less than the distance to any
 * boundary not through that midpoint — lands once in every face. The
 * interiors meet iff one of those points is inside both polygons.
 */
export function footprintsOverlap(pa: V2[], pb: V2[]): boolean {
  const edges = (poly: V2[]): [V2, V2][] => {
    const out: [V2, V2][] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a[0] !== b[0] || a[1] !== b[1]) out.push([a, b]);
    }
    return out;
  };
  const ea = edges(pa);
  const eb = edges(pb);
  if (ea.length < 3 || eb.length < 3) return false;
  const all = [...ea, ...eb];
  let scale = 0;
  for (const p of [...pa, ...pb]) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  // a boundary closer than this to a midpoint runs through it (float noise)
  const through = 1e-12 * (1 + scale);

  const cuts = (e: [V2, V2], others: [V2, V2][]): number[] => {
    const [a, b] = e;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const ts = [0, 1];
    const along = (p: V2): number => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
    for (const [c, d] of others) {
      const ox = d[0] - c[0];
      const oz = d[1] - c[1];
      const den = dx * oz - dz * ox;
      // the other boundary's ends that sit on this edge (collinear runs,
      // T-touches) split it as well as a crossing does
      for (const p of [c, d]) if (segDist(p, a, b) <= through) ts.push(along(p));
      if (den === 0) continue;
      const t = ((c[0] - a[0]) * oz - (c[1] - a[1]) * ox) / den;
      const u = ((c[0] - a[0]) * dz - (c[1] - a[1]) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    return ts.filter((t) => t >= 0 && t <= 1).sort((x, y) => x - y);
  };

  for (const [e, others] of [
    ...ea.map((e) => [e, eb] as const),
    ...eb.map((e) => [e, ea] as const),
  ]) {
    const [a, b] = e;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz);
    const n: V2 = [-dz / l, dx / l];
    const ts = cuts(e, others);
    for (let k = 0; k + 1 < ts.length; k++) {
      const piece = (ts[k + 1] - ts[k]) * l;
      if (piece <= through) continue;
      const tm = (ts[k] + ts[k + 1]) / 2;
      const m: V2 = [a[0] + dx * tm, a[1] + dz * tm];
      let room = piece / 2;
      for (const [c, d] of all) {
        const dist = segDist(m, c, d);
        if (dist > through) room = Math.min(room, dist);
      }
      const step = room / 2;
      for (const side of [1, -1]) {
        const p: V2 = [m[0] + n[0] * step * side, m[1] + n[1] * step * side];
        if (inPoly(pa, p) && inPoly(pb, p)) return true;
      }
    }
  }
  return false;
}
