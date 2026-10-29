import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import type { StairGeo } from "../stairs/place.js";
import type { Mesh } from "./geometry.js";
import { boxMesh } from "./beams.js";
import { MeshBuilder } from "./mesh.js";
import type { V3 } from "./mesh.js";
import { EXTERIOR } from "./walls.js";

/** handrail bar: 0.04 × 0.04, its underside 0.9 m over the nose line (spec "Лестницы") */
export const RAIL_BAR = 0.04;
export const RAIL_H = 0.9;
/** a flight side gets a rail only when the wall face there is further out */
export const RAIL_CLEAR = 0.15;

/** A box whose bottom and top slide linearly from `p0` to `p1`. */
function rampBox(
  m: Omit<Mesh, "positions" | "normals" | "uvs" | "indices">,
  p0: V2,
  p1: V2,
  w: number,
  yb0: number,
  yb1: number,
  h: number,
): Mesh {
  const dx = p1[0] - p0[0];
  const dz = p1[1] - p0[1];
  const l = Math.hypot(dx, dz) || 1;
  const ax: V2 = [dx / l, dz / l];
  const pr: V2 = [-ax[1], ax[0]];
  const hw = w / 2;
  const at = (e: 0 | 1, side: number, up: 0 | 1): V3 => {
    const p = e === 0 ? p0 : p1;
    const yb = e === 0 ? yb0 : yb1;
    return [p[0] + pr[0] * side * hw, yb + up * h, p[1] + pr[1] * side * hw];
  };
  const mb = new MeshBuilder();
  const dy = yb1 - yb0;
  const slope = Math.hypot(l, dy);
  const quad = (a: V3, b: V3, c: V3, d: V3, n: V3, u: number, v: number): void =>
    mb.quad(a, b, c, d, n, [0, 0], [u, 0], [u, v], [0, v]);
  // the top and bottom faces lean with the flight, so their normal does too
  const nUp: V3 = [(-dy / slope) * ax[0], l / slope, (-dy / slope) * ax[1]];
  quad(at(0, -1, 1), at(1, -1, 1), at(1, 1, 1), at(0, 1, 1), nUp, slope, w);
  quad(at(0, -1, 0), at(1, -1, 0), at(1, 1, 0), at(0, 1, 0), [-nUp[0], -nUp[1], -nUp[2]], slope, w);
  quad(at(0, 1, 0), at(1, 1, 0), at(1, 1, 1), at(0, 1, 1), [pr[0], 0, pr[1]], slope, h);
  quad(at(0, -1, 0), at(1, -1, 0), at(1, -1, 1), at(0, -1, 1), [-pr[0], 0, -pr[1]], slope, h);
  quad(at(1, -1, 0), at(1, 1, 0), at(1, 1, 1), at(1, -1, 1), [ax[0], 0, ax[1]], w, h);
  quad(at(0, -1, 0), at(0, 1, 0), at(0, 1, 1), at(0, -1, 1), [-ax[0], 0, -ax[1]], w, h);
  return mb.finish(m);
}

/** The xz trace of one vertical wall triangle. */
interface Seg {
  a: V2;
  b: V2;
}

/** wall pieces a rail can run into: faces, bands, end caps and door jambs */
const SOLID: ReadonlySet<Mesh["kind"]> = new Set(["wall", "band", "cap", "reveal"]);

/**
 * The walls exactly as they were built: every vertical triangle of a wall
 * mesh, flattened to its xz trace. Measuring against the
 * built faces instead of re-deriving them from the room outline means a rail
 * sees whatever thickness each stretch of wall really has (a shared wall at
 * the thicker room's thickness, an edge split into intervals of different
 * thickness, a free wall, another room's wall) without a second copy of
 * the wall rules that can drift from `walls.ts`.
 */
export function wallTraces(meshes: Mesh[]): Seg[] {
  const out: Seg[] = [];
  for (const m of meshes) {
    if (!SOLID.has(m.kind)) continue;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ix = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      // horizontal tops and sills carry ±Y normals; only the upright ones bound a rail
      if (ix.some((i) => Math.abs(m.normals[i * 3 + 1]) > 1e-9)) continue;
      const p = ix.map((i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);
      // the trace of a vertical triangle is a segment: its two furthest points
      let best = -1;
      let a: V2 = [0, 0];
      let b: V2 = [0, 0];
      for (const [u, w] of [
        [0, 1],
        [1, 2],
        [0, 2],
      ]) {
        const d = Math.hypot(p[u][0] - p[w][0], p[u][2] - p[w][2]);
        if (d > best) {
          best = d;
          a = [p[u][0], p[u][2]];
          b = [p[w][0], p[w][2]];
        }
      }
      if (best < EPS) continue;
      out.push({ a, b });
    }
  }
  return out;
}

/**
 * Shortest wall clearance along the whole flight side, measured sideways
 * along `v` from the flight edge `p0 + s*dir`, s in [0, len], to every wall
 * face of the level. For one face both the ray distance and the face
 * parameter are affine in `s`, so the range of `s` where the ray hits the face
 * is one interval found analytically — a sampled sweep can step clean over a
 * wall feature thinner than its step. Height is not looked at: the spec
 * measures the side of the flight to the wall, not the rail bar.
 */
function minRayDist(segs: Seg[], p0: V2, dir: V2, v: V2, len: number): number {
  let best = Infinity;
  for (const seg of segs) {
    const e0 = seg.a;
    const e1 = seg.b;
    const ex = e1[0] - e0[0];
    const ez = e1[1] - e0[1];
    const den = v[0] * ez - v[1] * ex;
    if (Math.abs(den) < EPS) continue;

    // rayT(s) = (A - s*B) / den; u(s) = (s*D - C) / den
    const A = (e0[0] - p0[0]) * ez - (e0[1] - p0[1]) * ex;
    const B = dir[0] * ez - dir[1] * ex;
    const C = v[0] * (e0[1] - p0[1]) - v[1] * (e0[0] - p0[0]);
    const D = v[0] * dir[1] - v[1] * dir[0];

    let lo = 0;
    let hi = len;

    // u(s) in [0, 1]
    if (Math.abs(D) < EPS) {
      const u0 = -C / den;
      if (u0 < -EPS || u0 > 1 + EPS) continue;
    } else {
      const sAt = (u: number): number => (u * den + C) / D;
      const s0 = sAt(0);
      const s1 = sAt(1);
      lo = Math.max(lo, Math.min(s0, s1));
      hi = Math.min(hi, Math.max(s0, s1));
    }
    if (lo > hi + EPS) continue;

    // rayT(s) >= -EPS: a face the edge already sits on counts as zero
    // clearance, only faces behind the edge are skipped
    if (Math.abs(B) < EPS) {
      if (A / den < -EPS) continue;
    } else {
      const sStar = (A + EPS * den) / B;
      if (-B / den > 0) lo = Math.max(lo, sStar);
      else hi = Math.min(hi, sStar);
    }
    if (lo > hi + EPS) continue;

    const rayAt = (s: number): number => Math.max(0, (A - s * B) / den);
    best = Math.min(best, rayAt(lo), rayAt(hi));
  }
  return best;
}

export interface StairMeshOpts {
  /** raw scene room by id, for materials and its level */
  sceneRoom: Map<string, any>;
  /** the wall meshes already built on a level: what a rail keeps clear of */
  walls: (level: string) => Mesh[];
  /** floor level of a room */
  levelY: (room: string) => number;
}

const wallsOf = (src: any): string => String(src?.walls?.material ?? EXTERIOR);

/** Steps, flight rails and cut rails of every flight that was laid out. */
export function stairMeshes(ctx: Ctx, opts: StairMeshOpts): Mesh[] {
  const scene: any = ctx.scene;
  const geos = ((ctx as any).stairs ?? []) as StairGeo[];
  const out: Mesh[] = [];
  const traces = new Map<string, Seg[]>();
  const tracesOf = (level: string): Seg[] => {
    let t = traces.get(level);
    if (!t) traces.set(level, (t = wallTraces(opts.walls(level))));
    return t;
  };
  for (const g of geos) {
    if (g.bad) continue;
    const src = (scene.stairs ?? [])[g.i] ?? {};
    const fromRoom = String(src.from?.room);
    const toRoom = String(src.to?.room);
    const fromSrc = opts.sceneRoom.get(fromRoom);
    const hw = g.width / 2;
    // the flight runs along `dir`; left/right are named looking up (spec)
    const left: V2 = [g.dir[1], -g.dir[0]];
    const sideVec = (side: "left" | "right"): V2 => (side === "left" ? left : [-left[0], -left[1]]);
    const axisAt = (s: number): V2 => [g.from[0] + g.dir[0] * s, g.from[1] + g.dir[1] * s];
    const nose = (s: number): number => g.y0 + g.rise + (s * g.rise) / g.going;

    for (let k = 1; k <= g.n - 1; k++) {
      const c = axisAt((k - 0.5) * g.going);
      out.push(
        boxMesh(
          `${g.id}:step:${k}`,
          "step",
          String(fromSrc?.floor ?? EXTERIOR),
          fromRoom,
          [c[0] + left[0] * hw, c[1] + left[1] * hw],
          [c[0] - left[0] * hw, c[1] - left[1] * hw],
          g.going,
          g.y0,
          g.y0 + k * g.rise,
        ),
      );
    }

    if (!src.rail) continue;

    // the flight's own level only: a wall upstairs that crosses over the low
    // end of the flight is not beside it
    const faces = tracesOf(String(fromSrc?.level));
    for (const side of ["left", "right"] as const) {
      const v = sideVec(side);
      const edge = (s: number): V2 => {
        const c = axisAt(s);
        return [c[0] + v[0] * hw, c[1] + v[1] * hw];
      };
      // the nearest wall face along the whole flight decides, not one sample
      const room = minRayDist(faces, edge(0), g.dir, v, g.len);
      if (!(room > RAIL_CLEAR + EPS)) continue;
      out.push(
        rampBox(
          { id: `${g.id}:rail:${side}`, kind: "rail", material: wallsOf(fromSrc), room: fromRoom },
          edge(0),
          edge(g.len),
          RAIL_BAR,
          nose(0) + RAIL_H,
          nose(g.len) + RAIL_H,
          RAIL_BAR,
        ),
      );
    }

    // rails around the hole the flight cut in the slab, except on the side the
    // flight walks out of (a rail there would block the exit)
    if (!g.cut) continue;
    const yTop = opts.levelY(toRoom);
    const toSrc = opts.sceneRoom.get(toRoom);
    const sOf = (p: V2): number => (p[0] - g.from[0]) * g.dir[0] + (p[1] - g.from[1]) * g.dir[1];
    g.cut.forEach((a, k) => {
      const b = g.cut![(k + 1) % g.cut!.length];
      if (Math.abs(sOf(a) - g.len) < 1e-3 && Math.abs(sOf(b) - g.len) < 1e-3) return;
      out.push(
        boxMesh(
          `${g.id}:rail:cut:${k}`,
          "rail",
          wallsOf(toSrc),
          toRoom,
          a,
          b,
          RAIL_BAR,
          yTop + RAIL_H,
          yTop + RAIL_H + RAIL_BAR,
        ),
      );
    });
  }
  return out;
}
