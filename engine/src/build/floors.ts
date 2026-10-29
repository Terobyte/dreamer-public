import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import type { Mesh } from "./geometry.js";
import { MeshBuilder } from "./mesh.js";
import { facePoly } from "./slab.js";

/** Ear clipping over a simple polygon; returns index triples into `poly`. */
export function earClip(poly: V2[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const area2 = (): number => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s;
  };
  // work on a CCW copy so an ear is a convex vertex
  const idx = Array.from({ length: n }, (_, i) => i);
  if (area2() < 0) idx.reverse();
  const cross = (o: V2, a: V2, b: V2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  // inclusive of the triangle's own edges: a reflex vertex sitting exactly on
  // a candidate ear's diagonal still blocks it, otherwise the ear would swallow
  // the notch that vertex carves out of the polygon (F1)
  const inside = (p: V2, a: V2, b: V2, c: V2): boolean => {
    const d0 = cross(a, b, p);
    const d1 = cross(b, c, p);
    const d2 = cross(c, a, p);
    return d0 >= -EPS && d1 >= -EPS && d2 >= -EPS;
  };
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10 * n) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length];
      const ib = idx[k];
      const ic = idx[(k + 1) % idx.length];
      const a = poly[ia];
      const b = poly[ib];
      const c = poly[ic];
      if (cross(a, b, c) <= EPS) continue;
      let blocked = false;
      const same = (p: V2, q: V2): boolean => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;
      for (const other of idx) {
        if (other === ia || other === ib || other === ic) continue;
        // a hole is bridged in with two coincident edges, so the polygon holds
        // the bridge's endpoints twice; a duplicate of the ear's own corner
        // must not block it, or the whole hole stays untriangulated
        if (same(poly[other], a) || same(poly[other], b) || same(poly[other], c)) continue;
        if (inside(poly[other], a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push(ia, ib, ic);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** A horizontal slab over the room outline minus `holes`: floor (+Y) or ceiling (−Y). */
export function horizontalFace(
  id: string,
  kind: "floor" | "ceiling",
  material: string,
  room: string,
  outline: V2[],
  y: number,
  holes: V2[][] = [],
): Mesh {
  const n: [number, number, number] = kind === "floor" ? [0, 1, 0] : [0, -1, 0];
  const mb = new MeshBuilder();
  // a stairwell cut is a hole, and `earClip` only eats simple polygons
  const poly = holes.length > 0 ? facePoly(outline, holes) : outline;
  const tris = earClip(poly);
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
  return mb.finish({ id, kind, material, room });
}
