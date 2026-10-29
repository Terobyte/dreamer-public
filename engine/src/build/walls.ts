import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import type { Interval } from "../plan/merge.js";
import type { OpeningGeo } from "../openings/resolve.js";
import type { Mesh } from "./geometry.js";
import { MeshBuilder } from "./mesh.js";
import type { V3 } from "./mesh.js";

export const EXTERIOR = "$exterior";

export interface WallRoom {
  id: string;
  height: number;
  /** inward normal of the author edge this interval belongs to */
  normalIn: V2;
  wallMaterial: string;
  bands: { to: number; material: string }[];
}

export interface WallEnv {
  levelY: number;
  /** room data for a side of an interval, or null when the side has no room */
  room: (side: { room: string; edge: number }) => WallRoom;
  openings: OpeningGeo[];
  /** shared `cap:<k>` counter */
  caps: { k: number };
}

/** Axis polyline of an interval: straight ends, or the arc sampled at 0.25 m
 *  with every opening's chord ends inserted, so the opening sits on one flat
 *  panel (spec "Проём на дуге"). */
export function axisPoly(iv: Interval, openings: OpeningGeo[]): { pts: V2[]; u: number[]; wrap: boolean[] } {
  if (!iv.arc) {
    const pts = [iv.from, iv.to];
    return { pts, u: [0, Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])], wrap: openings.map(() => false) };
  }
  const { c, r } = iv.arc;
  const sweep = iv.arc.sweep ?? 0;
  const full = Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-6;
  const a0 = Math.atan2(iv.from[0] - c[0], iv.from[1] - c[1]);
  const TAU = 2 * Math.PI;
  const relOf = (ref: number, p: V2): number => {
    const a = Math.atan2(p[0] - c[0], p[1] - c[1]);
    let rel = a - ref;
    while (rel > Math.PI) rel -= TAU;
    while (rel < -Math.PI) rel += TAU;
    return rel;
  };
  const at = (t: number): V2 => {
    const a = a0 + sweep * t;
    return [c[0] + r * Math.sin(a), c[1] + r * Math.cos(a)];
  };
  const tOf = (p: V2): number => {
    const rel = relOf(a0, p);
    let t = sweep === 0 ? 0 : rel / sweep;
    if (full && t < 0) t += 1;
    return t;
  };
  const n = Math.max(1, Math.ceil(Math.abs(r * sweep) / 0.25));
  // an opening spanning more than half the parameter range reads as
  // wrapping through t=0/1 rather than covering the long way around
  // (mirrors Hole.wrap below), so u is always distance from interval.from
  // and the seam never has to move off it to dodge a hole
  // (F11/F16/F18/F19/F20)
  const holeTs: [number, number][] = openings.map((o) => o.ends.map(tOf).sort((x, y) => x - y) as [number, number]);
  // the opening's own center decides which way round it goes; exactly half a
  // circle is otherwise a tie the span length cannot break
  const wrap = openings.map((o, i) => {
    if (!full) return false;
    const [lo, hi] = holeTs[i];
    if (!o.center) return hi - lo > 0.5;
    const tc = tOf(o.center);
    return !(tc > lo && tc < hi);
  });
  const inHole = (t: number): boolean =>
    holeTs.some(([lo, hi], i) => (wrap[i] ? t < lo - 1e-9 || t > hi + 1e-9 : t > lo + 1e-9 && t < hi - 1e-9));

  type Item = { t: number; p: V2; cut: boolean };
  const items: Item[] = [];
  for (let i = 0; i <= n; i++) items.push({ t: i / n, p: at(i / n), cut: false });
  for (const o of openings) for (const e of o.ends) items.push({ t: tOf(e), p: e, cut: true });
  items.sort((x, y) => x.t - y.t);
  // the canonical polyline over the whole circumference, independent of
  // which samples later get dropped as falling inside a hole: u is always
  // measured along this, so it stays "distance from interval.from" even
  // for a point whose own grid sample would otherwise be excluded
  const canon: Item[] = [];
  for (const it of items) {
    const last = canon[canon.length - 1];
    if (last && Math.hypot(last.p[0] - it.p[0], last.p[1] - it.p[1]) < 1e-9) continue;
    canon.push(it);
  }
  // u follows the 0.25 m sampled polyline only: an inserted chord end sits
  // between two samples at its t share of that segment, so it never
  // lengthens the polyline and shifts every u after it
  const segLen = 2 * r * Math.sin(Math.abs(sweep) / (2 * n));
  const canonU = canon.map((it) => it.t * n * segLen);
  const pts: V2[] = [];
  const u: number[] = [];
  for (let i = 0; i < canon.length; i++) {
    const it = canon[i];
    if (!it.cut && inHole(it.t)) continue;
    pts.push(it.p);
    u.push(canonU[i]);
  }
  // a hole across t=0 leaves the chain open between its chord ends: close it
  // with the chord, u unwrapped past the last end
  if (wrap.some(Boolean) && pts.length > 1) {
    const a = pts[pts.length - 1];
    const b = pts[0];
    pts.push(b);
    u.push(u[u.length - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts, u, wrap };
}

function perp(a: V2, b: V2): V2 {
  const d: V2 = [b[0] - a[0], b[1] - a[1]];
  const l = Math.hypot(d[0], d[1]) || 1;
  return [-d[1] / l, d[0] / l];
}

/** Perpendicular of the panel a→b oriented like `ref` (for arcs `ref` is
 *  rebuilt per panel so the normal stays radial). */
function panelNormal(iv: Interval, a: V2, b: V2, towardCenter: boolean | null, ref: V2): V2 {
  const n = perp(a, b);
  let r = ref;
  if (iv.arc && towardCenter !== null) {
    const mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const rad: V2 = [iv.arc.c[0] - mid[0], iv.arc.c[1] - mid[1]];
    r = towardCenter ? rad : [-rad[0], -rad[1]];
  }
  return n[0] * r[0] + n[1] * r[1] >= 0 ? n : [-n[0], -n[1]];
}

export function uOfPoint(poly: { pts: V2[]; u: number[] }, p: V2): number {
  // an exact vertex match must return its own recorded u: projecting onto
  // the two segments meeting there ties at distance 0, and picking the
  // wrong one silently crosses the seam-wrap bridge (surfaced by F9/F11's fix)
  for (let i = 0; i < poly.pts.length; i++) {
    if (Math.hypot(poly.pts[i][0] - p[0], poly.pts[i][1] - p[1]) < 1e-9) return poly.u[i];
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < poly.pts.length; i++) {
    const a = poly.pts[i];
    const b = poly.pts[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
    if (d < bestD - 1e-12) {
      bestD = d;
      best = poly.u[i] + t * Math.sqrt(l2);
    }
  }
  return best;
}

/** `forward` skips a segment that merely ends at `u`, so a point sitting
 *  exactly on a cut (e.g. the start of an opening's chord) resolves to the
 *  segment beginning there rather than the arc segment preceding it (F4). */
function pointAtU(poly: { pts: V2[]; u: number[] }, u: number, forward = false): { p: V2; dir: V2 } {
  for (let i = 0; i + 1 < poly.pts.length; i++) {
    const atEnd = i + 2 === poly.pts.length;
    const within = forward ? poly.u[i + 1] > u + 1e-9 || atEnd : u <= poly.u[i + 1] + 1e-9 || atEnd;
    if (within) {
      const a = poly.pts[i];
      const b = poly.pts[i + 1];
      const seg = poly.u[i + 1] - poly.u[i] || 1;
      const t = (u - poly.u[i]) / seg;
      const dir: V2 = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir };
    }
  }
  const a = poly.pts[0];
  return { p: a, dir: [1, 0] };
}

interface Hole {
  u: [number, number];
  v: [number, number];
  /** true when the opening's u-span was re-based onto the original
   *  interval.from and now straddles the u=0/circumference seam (F15):
   *  the hole is then the complement of [u[0], u[1]], not the range itself */
  wrap?: boolean;
}

interface Piece {
  v: [number, number];
  kind: "wall" | "band";
  material: string;
  side: string;
  room?: string;
}

function uniqSorted(xs: number[]): number[] {
  const s = [...xs].sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of s) if (out.length === 0 || x - out[out.length - 1] > 1e-9) out.push(x);
  return out;
}

/** One face of an interval: a strip per panel, split by bands and opening cuts. */
function faceMeshes(
  iv: Interval,
  poly: { pts: V2[]; u: number[]; wrap?: boolean[] },
  normalRef: V2,
  towardCenter: boolean | null,
  pieces: Piece[],
  holes: Hole[],
  levelY: number,
  idFor: (side: string) => string,
): Mesh[] {
  const out: Mesh[] = [];
  const off = iv.thickness / 2;
  // Offsets are per vertex, so the arc and the flat panel of an opening meet
  // without a seam. A vertex on an opening's chord follows the chord's own
  // normal, which puts the whole flat panel on one plane (spec "Проём на дуге").
  const segNormal = (i: number): V2 => panelNormal(iv, poly.pts[i], poly.pts[i + 1], towardCenter, normalRef);
  const vn: V2[] = poly.pts.map((p, i) => {
    if (!iv.arc) return segNormal(Math.min(i, poly.pts.length - 2));
    const rad: V2 = [iv.arc.c[0] - p[0], iv.arc.c[1] - p[1]];
    const l = Math.hypot(rad[0], rad[1]) || 1;
    const r: V2 = [rad[0] / l, rad[1] / l];
    return towardCenter ? r : [-r[0], -r[1]];
  });
  for (const h of holes) {
    const last = poly.pts.length - 1;
    if (h.wrap && last > 0 && Math.abs(poly.u[last - 1] - h.u[1]) < 1e-9) {
      const n = segNormal(last - 1);
      vn[last - 1] = n;
      vn[last] = n;
      vn[0] = n;
    }
    for (let i = 0; i + 1 < poly.pts.length; i++) {
      if (Math.abs(poly.u[i] - h.u[0]) < 1e-9 && Math.abs(poly.u[i + 1] - h.u[1]) < 1e-9) {
        const n = segNormal(i);
        vn[i] = n;
        vn[i + 1] = n;
      }
    }
  }
  const op: V2[] = poly.pts.map((p, i) => [p[0] + vn[i][0] * off, p[1] + vn[i][1] * off]);
  for (let i = 0; i + 1 < poly.pts.length; i++) {
    const a = op[i];
    const b = op[i + 1];
    const n = panelNormal(iv, a, b, towardCenter, normalRef);
    const n3: V3 = [n[0], 0, n[1]];
    const pu0 = poly.u[i];
    const pu1 = poly.u[i + 1];
    if (pu1 - pu0 < EPS) continue;
    const at = (u: number, v: number): V3 => {
      const t = (u - pu0) / (pu1 - pu0);
      return [a[0] + (b[0] - a[0]) * t, levelY + v, a[1] + (b[1] - a[1]) * t];
    };
    for (const piece of pieces) {
      if (piece.v[1] - piece.v[0] < EPS) continue;
      const mb = new MeshBuilder();
      const xs = uniqSorted([
        pu0,
        pu1,
        ...holes.flatMap((h) => h.u.filter((u) => u > pu0 + 1e-9 && u < pu1 - 1e-9)),
      ]);
      const ys = uniqSorted([
        piece.v[0],
        piece.v[1],
        ...holes.flatMap((h) => h.v.filter((v) => v > piece.v[0] + 1e-9 && v < piece.v[1] - 1e-9)),
      ]);
      for (let x = 0; x + 1 < xs.length; x++) {
        for (let y = 0; y + 1 < ys.length; y++) {
          const cu = (xs[x] + xs[x + 1]) / 2;
          const cv = (ys[y] + ys[y + 1]) / 2;
          const cut = holes.some((h) => {
            const inU = h.wrap ? cu < h.u[0] + 1e-9 || cu > h.u[1] - 1e-9 : cu > h.u[0] - 1e-9 && cu < h.u[1] + 1e-9;
            return inU && cv > h.v[0] - 1e-9 && cv < h.v[1] + 1e-9;
          });
          if (cut) continue;
          const p00 = at(xs[x], ys[y]);
          const p10 = at(xs[x + 1], ys[y]);
          const p11 = at(xs[x + 1], ys[y + 1]);
          const p01 = at(xs[x], ys[y + 1]);
          mb.quad(p00, p10, p11, p01, n3, [xs[x], ys[y]], [xs[x + 1], ys[y]], [xs[x + 1], ys[y + 1]], [xs[x], ys[y + 1]]);
        }
      }
      if (mb.empty) continue;
      out.push(mb.finish({ id: idFor(piece.side), kind: piece.kind, material: piece.material, side: piece.side, room: piece.room }));
    }
  }
  return out;
}

function piecesFor(room: WallRoom, material: string, side: string): Piece[] {
  const out: Piece[] = [];
  let v = 0;
  for (const b of [...room.bands].sort((x, y) => x.to - y.to)) {
    if (b.to <= v + EPS) continue;
    out.push({ v: [v, Math.min(b.to, room.height)], kind: "band", material: b.material, side, room: room.id });
    v = b.to;
  }
  if (room.height - v > EPS) out.push({ v: [v, room.height], kind: "wall", material, side, room: room.id });
  return out;
}

/** Top and end faces of the wall body. */
function capMeshes(iv: Interval, poly: { pts: V2[]; u: number[] }, levelY: number, top: number, k: number): Mesh {
  const mb = new MeshBuilder();
  const off = iv.thickness / 2;
  const yTop = levelY + top;
  for (let i = 0; i + 1 < poly.pts.length; i++) {
    const a = poly.pts[i];
    const b = poly.pts[i + 1];
    const n = perp(a, b);
    const pt = (p: V2, s: number): V3 => [p[0] + n[0] * s * off, yTop, p[1] + n[1] * s * off];
    const uv = (p: V3): [number, number] => [p[0], p[2]];
    const q = [pt(a, 1), pt(b, 1), pt(b, -1), pt(a, -1)];
    mb.quad(q[0], q[1], q[2], q[3], [0, 1, 0], uv(q[0]), uv(q[1]), uv(q[2]), uv(q[3]));
  }
  // a closed interval (from === to, e.g. a full circle) has no ends to cap
  const closed = Math.hypot(iv.from[0] - iv.to[0], iv.from[1] - iv.to[1]) < 1e-6;
  const ends: { p: V2; n: V2 }[] = closed
    ? []
    : [
        { p: poly.pts[0], n: norm2([poly.pts[0][0] - poly.pts[1][0], poly.pts[0][1] - poly.pts[1][1]]) },
        {
          p: poly.pts[poly.pts.length - 1],
          n: norm2([
            poly.pts[poly.pts.length - 1][0] - poly.pts[poly.pts.length - 2][0],
            poly.pts[poly.pts.length - 1][1] - poly.pts[poly.pts.length - 2][1],
          ]),
        },
      ];
  for (const e of ends) {
    const t: V2 = [-e.n[1], e.n[0]];
    const c = (s: number, y: number): V3 => [e.p[0] + t[0] * s * off, y, e.p[1] + t[1] * s * off];
    const q = [c(-1, levelY), c(1, levelY), c(1, yTop), c(-1, yTop)];
    mb.quad(q[0], q[1], q[2], q[3], [e.n[0], 0, e.n[1]], [0, levelY], [2 * off, levelY], [2 * off, yTop], [0, yTop]);
  }
  return mb.finish({ id: `cap:${k}`, kind: "cap", material: EXTERIOR, side: EXTERIOR });
}

function norm2(v: V2): V2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Jambs, head and sill of one opening, in the thickness of the wall. */
function revealMeshes(o: OpeningGeo, iv: Interval, poly: { pts: V2[]; u: number[] }, levelY: number, hole: Hole): Mesh[] {
  const off = iv.thickness / 2;
  const out: Mesh[] = [];
  const y0 = levelY + hole.v[0];
  const y1 = levelY + hole.v[1];
  const a = pointAtU(poly, hole.u[0], true);
  const b = pointAtU(poly, hole.u[1]);
  // The whole reveal sits on the chord between the two ends, so its frame
  // comes from that chord and not from whichever panel happens to start at
  // u[0]: for a hole across the seam that panel is the arc running away from
  // the gap, which pointed both jambs and the thickness the wrong way (D3).
  const dir = norm2([b.p[0] - a.p[0], b.p[1] - a.p[1]]);
  const n: V2 = [-dir[1], dir[0]];
  let k = 0;
  const jamb = (p: V2, sign: number): void => {
    const c = (s: number, y: number): V3 => [p[0] + n[0] * s * off, y, p[1] + n[1] * s * off];
    const mb = new MeshBuilder();
    const q = [c(-1, y0), c(1, y0), c(1, y1), c(-1, y1)];
    mb.quad(q[0], q[1], q[2], q[3], [dir[0] * sign, 0, dir[1] * sign], [0, y0 - levelY], [2 * off, y0 - levelY], [2 * off, y1 - levelY], [0, y1 - levelY]);
    out.push(mb.finish({ id: `${o.id}:reveal:${k++}`, kind: "reveal", material: EXTERIOR, side: EXTERIOR }));
  };
  jamb(a.p, 1);
  jamb(b.p, -1);
  const horiz = (y: number, ny: number): void => {
    const c = (p: V2, s: number): V3 => [p[0] + n[0] * s * off, y, p[1] + n[1] * s * off];
    const mb = new MeshBuilder();
    const q = [c(a.p, -1), c(b.p, -1), c(b.p, 1), c(a.p, 1)];
    mb.quad(q[0], q[1], q[2], q[3], [0, ny, 0], [q[0][0], q[0][2]], [q[1][0], q[1][2]], [q[2][0], q[2][2]], [q[3][0], q[3][2]]);
    out.push(mb.finish({ id: `${o.id}:reveal:${k++}`, kind: "reveal", material: EXTERIOR, side: EXTERIOR }));
  };
  horiz(y1, -1);
  if (hole.v[0] > EPS) horiz(y0, 1);
  return out;
}

/** All meshes of one interval: both faces, the `$exterior` top-up, caps, reveals. */
export function intervalMeshes(iv: Interval, env: WallEnv, next: (key: string) => number): Mesh[] {
  const openings = env.openings;
  const poly = axisPoly(iv, openings);
  const holes: Hole[] = openings.map((o, i) => {
    const us = [uOfPoint(poly, o.ends[0]), uOfPoint(poly, o.ends[1])].sort((a, b) => a - b);
    return { u: [us[0], us[1]] as [number, number], v: [o.sill, o.sill + o.height] as [number, number], wrap: poly.wrap[i] };
  });
  const rooms = iv.sides.map((s) => env.room(s));
  const top = Math.max(...rooms.map((r) => r.height));
  const base = `${iv.sides[0].room}#${iv.sides[0].edge}`;
  const idFor = (side: string): string => `${base}:${side}:${next(`${base}|${side}`)}`;
  const out: Mesh[] = [];

  for (let i = 0; i < iv.sides.length; i++) {
    const r = rooms[i];
    const edgeMat = r.wallMaterial;
    const towardCenter = iv.arc
      ? r.normalIn[0] * (iv.arc.c[0] - iv.from[0]) + r.normalIn[1] * (iv.arc.c[1] - iv.from[1]) >= 0
      : null;
    const pieces = piecesFor(r, edgeMat, r.id);
    if (top - r.height > EPS) {
      pieces.push({ v: [r.height, top], kind: "wall", material: EXTERIOR, side: EXTERIOR });
    }
    out.push(...faceMeshes(iv, poly, r.normalIn, towardCenter, pieces, holes, env.levelY, idFor));
  }

  if (iv.sides.length === 1) {
    const r = rooms[0];
    const outward: V2 = [-r.normalIn[0], -r.normalIn[1]];
    const towardCenter = iv.arc
      ? outward[0] * (iv.arc.c[0] - iv.from[0]) + outward[1] * (iv.arc.c[1] - iv.from[1]) >= 0
      : null;
    out.push(
      ...faceMeshes(
        iv,
        poly,
        outward,
        towardCenter,
        [{ v: [0, top], kind: "wall", material: EXTERIOR, side: EXTERIOR }],
        holes,
        env.levelY,
        idFor,
      ),
    );
  }

  out.push(capMeshes(iv, poly, env.levelY, top, env.caps.k++));
  for (let i = 0; i < openings.length; i++) out.push(...revealMeshes(openings[i], iv, poly, env.levelY, holes[i]));
  return out;
}
