import { Clipper, EndType, JoinType } from "clipper2-ts";
import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import { pointInPoly } from "../nav/floor.js";
import type { Mesh } from "./geometry.js";
import { MeshBuilder, type V3 } from "./mesh.js";
import { extrudeFace, signedArea2 } from "./slab.js";

/** A flat roof is a slab this thick on top of the walls. */
const FLAT_T = 0.15;
/** Gable pitch: the classic 35° of a pitched roof. */
const PITCH = (35 * Math.PI) / 180;

type Rect = { x0: number; x1: number; z0: number; z1: number };

/** The footprint grown by `o` metres with mitred corners: an L stays an L. */
function grow(outline: V2[], o: number): V2[] {
  if (o <= 0) return outline;
  const path = outline.map(([x, z]) => ({ x: Math.round(x * 1000), y: Math.round(z * 1000) }));
  const out = Clipper.inflatePaths([path], o * 1000, JoinType.Miter, EndType.Polygon, 4);
  if (out.length === 0) return outline;
  let best = out[0];
  for (const p of out) if (Math.abs(Clipper.area(p)) > Math.abs(Clipper.area(best))) best = p;
  return best.map((p) => [p.x / 1000, p.y / 1000] as V2);
}

const uniq = (vs: number[]): number[] =>
  [...vs].sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > EPS);

/**
 * An axis-aligned outline cut into a few rectangles that tile it exactly
 * (grid cells merged into maximal runs, then stacked rows); null when some
 * edge is diagonal or curved, since a gable has no obvious ridge there.
 */
function rectPieces(outline: V2[]): { rects: Rect[]; inside: (x: number, z: number) => boolean } | null {
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (Math.abs(a[0] - b[0]) > EPS && Math.abs(a[1] - b[1]) > EPS) return null;
  }
  const xs = uniq(outline.map((p) => p[0]));
  const zs = uniq(outline.map((p) => p[1]));
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const cell = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < nx && j < nz && pointInPoly([(xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2], outline);
  const used = new Set<string>();
  const free = (i: number, j: number): boolean => cell(i, j) && !used.has(`${i},${j}`);
  const rects: Rect[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!free(i, j)) continue;
      let i1 = i;
      while (free(i1 + 1, j)) i1++;
      let j1 = j;
      const rowFree = (jj: number): boolean => {
        for (let k = i; k <= i1; k++) if (!free(k, jj)) return false;
        return true;
      };
      while (rowFree(j1 + 1)) j1++;
      for (let jj = j; jj <= j1; jj++) for (let k = i; k <= i1; k++) used.add(`${k},${jj}`);
      rects.push({ x0: xs[i], x1: xs[i1 + 1], z0: zs[j], z1: zs[j1 + 1] });
    }
  }
  const inside = (x: number, z: number): boolean => pointInPoly([x, z], outline);
  return { rects, inside };
}

/**
 * The overhang a piece gets on each side: the full `o` where that whole side
 * is the outline's edge (outside lies past it), none where it borders another
 * piece — so eaves stick out past the facade but never into the next slope.
 */
function eaves(r: Rect, o: number, inside: (x: number, z: number) => boolean): Rect {
  const d = 1e-3;
  const outsideAlong = (fixed: number, from: number, to: number, alongX: boolean): boolean => {
    const n = Math.max(2, Math.ceil((to - from) / 0.25));
    for (let k = 0; k < n; k++) {
      const t = from + ((k + 0.5) * (to - from)) / n;
      if (alongX ? inside(t, fixed) : inside(fixed, t)) return false;
    }
    return true;
  };
  return {
    x0: r.x0 - (outsideAlong(r.x0 - d, r.z0, r.z1, false) ? o : 0),
    x1: r.x1 + (outsideAlong(r.x1 + d, r.z0, r.z1, false) ? o : 0),
    z0: r.z0 - (outsideAlong(r.z0 - d, r.x0, r.x1, true) ? o : 0),
    z1: r.z1 + (outsideAlong(r.z1 + d, r.x0, r.x1, true) ? o : 0),
  };
}

/** Two slopes meeting at a ridge along the piece's long side, closed by two triangular gable ends. */
function gable(mb: MeshBuilder, r: Rect, top: number): void {
  const { x0, x1, z0, z1 } = r;
  // ridge along the longer axis; (u, v) = (along ridge, across), mapped back to (x, z)
  const alongX = x1 - x0 >= z1 - z0;
  const [u0, u1, v0, v1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const P = (u: number, y: number, v: number): V3 => (alongX ? [u, y, v] : [v, y, u]);
  const vm = (v0 + v1) / 2;
  const half = (v1 - v0) / 2;
  const rise = half * Math.tan(PITCH);
  const slope = Math.hypot(half, rise);
  // each slope: normal tilts away from the ridge; UV in metres along the slope
  for (const [vEave, sgn] of [
    [v0, -1],
    [v1, 1],
  ] as const) {
    const nAcross = sgn * Math.sin(PITCH);
    const n: V3 = alongX ? [0, Math.cos(PITCH), nAcross] : [nAcross, Math.cos(PITCH), 0];
    mb.quad(
      P(u0, top, vEave),
      P(u1, top, vEave),
      P(u1, top + rise, vm),
      P(u0, top + rise, vm),
      n,
      [0, 0],
      [u1 - u0, 0],
      [u1 - u0, slope],
      [0, slope],
    );
  }
  for (const [u, sgn] of [
    [u0, -1],
    [u1, 1],
  ] as const) {
    const n: V3 = alongX ? [sgn, 0, 0] : [0, 0, sgn];
    mb.tri(P(u, top, v0), P(u, top, v1), P(u, top + rise, vm), n, [0, 0], [v1 - v0, 0], [half, rise]);
  }
}

/**
 * A roof over a room's footprint (В4), never over its bounding box: an L
 * room gets an L roof. `flat` is a thin slab over the outline grown by
 * `overhang` on every side. `gable` cuts an axis-aligned outline into
 * rectangles and pitches each one (a cross-gable on an L); an outline with a
 * diagonal or curved edge has no clear ridge, so it gets the flat slab.
 */
export function roofMeshes(
  room: string,
  roof: { material: string; kind: "flat" | "gable"; overhang?: number },
  outline: V2[],
  top: number,
): Mesh[] {
  const o = Number(roof.overhang ?? 0);
  const base = { id: `${room}:roof`, kind: "roof" as const, material: String(roof.material), room };
  const pieces = roof.kind === "gable" ? rectPieces(outline) : null;
  if (pieces === null || pieces.rects.length === 0) {
    const foot = grow(signedArea2(outline) < 0 ? [...outline].reverse() : outline, o);
    return [extrudeFace(base, foot, [], top, top + FLAT_T)];
  }
  const mb = new MeshBuilder();
  for (const r of pieces.rects) gable(mb, eaves(r, o, pieces.inside), top);
  return [{ ...base, positions: mb.positions, normals: mb.normals, uvs: mb.uvs, indices: mb.indices }];
}
