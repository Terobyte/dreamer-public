import type { Ctx } from "../ctx.js";
import type { DecalGeo, Issue, PropGeo, Stage } from "../types.js";
import type { V2 } from "../geom/vec.js";
import { EPS, SNAP_EPS } from "../geom/vec.js";
import { obbCorners } from "../geom/obb.js";
import type { AuthorEdge, RoomRec } from "../props/place.js";
import { edgeNormal, edgePoint, fracOf, isClosed, nearestEdge, specAng } from "../props/place.js";
import { msg } from "../report/messages.js";
import { round3 } from "../report/report.js";

const STAGE: Stage = "decals";
/** flat things sit this far off the inner face of the wall */
const FLAT_GAP = 0.02;
const DEFAULT_THICKNESS = 0.12;
/** a solid prop nearer than this to the face hides whatever is on it */
const HIDE_GAP = 0.15;

const TAU = Math.PI * 2;

function dir(a: number): V2 {
  return [Math.sin(a), Math.cos(a)];
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] - EPS && b[0] < a[1] - EPS;
}

function wrapTau(x: number): number {
  return ((x % TAU) + TAU) % TAU;
}

/** fraction of `e` closest to the angle `ang` seen from the arc centre */
function arcFrac(e: AuthorEdge, ang: number): number {
  if (isClosed(e)) return wrapTau(ang) / TAU;
  const sweep = e.arc!.sweep ?? 0;
  if (Math.abs(sweep) < EPS) return 0;
  const rel = wrapTau(ang - specAng(e.from, e.arc!.c));
  const f = sweep >= 0 ? rel / sweep : rel < EPS ? 0 : (rel - TAU) / sweep;
  return Math.min(1, Math.max(0, f));
}

/** `m` along the edge and depth of `p` past the inner face, measured inwards.
 *  `ref`, when given, picks the representative of `m` nearest to it on a closed
 *  edge, so several points near the same spot stay comparable across the seam. */
function projectOnEdge(p: V2, e: AuthorEdge, wallT: number, ref?: number): { m: number; depth: number } {
  if (!e.arc) {
    const dx = e.to[0] - e.from[0];
    const dz = e.to[1] - e.from[1];
    const l = Math.hypot(dx, dz) || 1;
    const m = ((p[0] - e.from[0]) * dx + (p[1] - e.from[1]) * dz) / l;
    const n = e.normalIn;
    return { m, depth: (p[0] - e.from[0]) * n[0] + (p[1] - e.from[1]) * n[1] - wallT / 2 };
  }
  const c = e.arc.c;
  const ang = specAng(p, c);
  const frac = arcFrac(e, ang);
  const axis = edgePoint(e, frac);
  const n = edgeNormal(e, axis);
  const face: V2 = [axis[0] + n[0] * (wallT / 2), axis[1] + n[1] * (wallT / 2)];
  let m = frac * e.len;
  if (isClosed(e) && ref !== undefined) {
    const len = e.len || 1;
    const d = m - ref;
    if (d > len / 2) m -= len;
    else if (d < -len / 2) m += len;
  }
  return { m, depth: (p[0] - face[0]) * n[0] + (p[1] - face[1]) * n[1] };
}

interface PlanInterval {
  from: V2;
  to: V2;
  arc: { c: V2; r: number; sweep?: number } | null;
  sides: Array<{ room: string; edge: number; m: [number, number] }>;
  thickness: number;
}

/** the plan interval (shared-wall strip) covering `q` on edge `e` of `room`, if any */
function findInterval(ctx: Ctx, room: RoomRec, e: AuthorEdge, q: V2): PlanInterval | undefined {
  const plan = ctx.levels?.get(room.level);
  const m = e.arc ? null : Math.hypot(q[0] - e.from[0], q[1] - e.from[1]);
  let best: PlanInterval | undefined;
  for (const iv of (plan?.intervals ?? []) as PlanInterval[]) {
    for (const s of iv.sides) {
      if (s.room !== e.room || s.edge !== e.i) continue;
      if (m !== null && (m < s.m[0] - EPS || m > s.m[1] + EPS)) continue;
      if (!best || iv.thickness > best.thickness) best = iv;
    }
  }
  return best;
}

/** a shared wall is as thick as its thickest side (see props/place.ts) */
function wallThicknessAt(ctx: Ctx, room: RoomRec, e: AuthorEdge, q: V2, own: number): number {
  const iv = findInterval(ctx, room, e, q);
  return iv ? iv.thickness : own;
}

/** physical coordinate of an edge-m value on `iv`'s shared axis, so a range's two
 *  ends compare on common ground. Only a closed edge (the circle seam) needs its
 *  angle kept unwrapped here — elsewhere there is no wrap to lose, so go through
 *  the world point as before. */
function rawPhysS(iv: PlanInterval, e: AuthorEdge, m: number): number {
  if (!isClosed(e)) {
    const p = edgePoint(e, m / (e.len || 1));
    if (!iv.arc) {
      const dx = iv.to[0] - iv.from[0];
      const dz = iv.to[1] - iv.from[1];
      const l = Math.hypot(dx, dz) || 1;
      return ((p[0] - iv.from[0]) * dx + (p[1] - iv.from[1]) * dz) / l;
    }
    const a0iv = specAng(iv.from, iv.arc.c);
    return wrapTau(specAng(p, iv.arc.c) - a0iv) * iv.arc.r;
  }
  const a0iv = specAng(iv.from, iv.arc!.c);
  const rate = TAU / (e.len || 1);
  return (rate * m - a0iv) * iv.arc!.r;
}

function ivClosed(iv: PlanInterval): boolean {
  return !!iv.arc && Math.hypot(iv.from[0] - iv.to[0], iv.from[1] - iv.to[1]) < EPS;
}

/** segments of a (possibly wrapping) range, split at the seam of a closed interval of length L */
function cyclicSegs(r: [number, number], L: number): Array<[number, number]> {
  const span = r[1] - r[0];
  if (span >= L - EPS) return [[0, L]];
  const lo = ((r[0] % L) + L) % L;
  const hi = lo + span;
  if (hi <= L + EPS) return [[lo, Math.min(hi, L)]];
  return [
    [lo, L],
    [0, hi - L],
  ];
}

/** overlap of two boundary-m ranges mapped onto a shared physical interval,
 *  via the edges each range was authored on; handles the t=0 seam on closed edges */
function physicalOverlap(
  iv: PlanInterval,
  aM: [number, number],
  aEdge: AuthorEdge,
  bM: [number, number],
  bEdge: AuthorEdge,
): boolean {
  const aS = aM.map((m) => rawPhysS(iv, aEdge, m));
  const bS = bM.map((m) => rawPhysS(iv, bEdge, m));
  const aRange: [number, number] = [Math.min(aS[0], aS[1]), Math.max(aS[0], aS[1])];
  const bRange: [number, number] = [Math.min(bS[0], bS[1]), Math.max(bS[0], bS[1])];
  if (!ivClosed(iv)) return overlaps(aRange, bRange);
  const L = TAU * iv.arc!.r;
  const as = cyclicSegs(aRange, L);
  const bs = cyclicSegs(bRange, L);
  for (const x of as) {
    for (const y of bs) {
      if (x[0] < y[1] - EPS && y[0] < x[1] - EPS) return true;
    }
  }
  return false;
}

export function placeDecals(ctx: Ctx): DecalGeo[] {
  const scene = ctx.scene as any;
  const rooms = (ctx.rooms ?? []) as RoomRec[];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const rawById = new Map<string, any>(((scene.rooms ?? []) as any[]).map((r) => [String(r.id), r]));
  const list: any[] = scene.decals ?? [];
  const out: DecalGeo[] = [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const roomId = String(raw?.on?.room ?? raw?.room ?? "");
    const room = roomById.get(roomId);
    if (!room) continue;
    const own = typeof rawById.get(roomId)?.walls?.thickness === "number"
      ? rawById.get(roomId).walls.thickness
      : DEFAULT_THICKNESS;
    const w = raw.size?.w ?? 0;
    const h = raw.size?.h ?? 0;
    const yc = typeof raw.y === "number" ? raw.y : 1.6;
    const lvl = (scene.levels ?? []).find((l: any) => String(l?.id) === room.level);
    const levelY = typeof lvl?.y === "number" ? lvl.y : 0;

    let e: AuthorEdge | undefined;
    let frac = 0;
    if (raw.on && typeof raw.on === "object") {
      e = room.edges.find((x) => x.i === raw.on.edge);
      if (!e) continue;
      frac = fracOf(e, raw.on);
    } else if (Array.isArray(raw.at)) {
      const near = nearestEdge([raw.at[0], raw.at[1]], room, own, false);
      if (!near || near.d >= SNAP_EPS) {
        out.push({
          i,
          room: roomId,
          noWall: true,
          d: near ? near.d : Infinity,
          edge: near ? near.e.id : `${roomId}#?`,
          w,
          h,
          y: yc,
        });
        continue;
      }
      e = near.e;
      frac = projectOnEdge(near.q, near.e, own).m / (near.e.len || 1);
      if (isClosed(near.e)) frac = arcFrac(near.e, specAng(near.q, near.e.arc!.c));
    } else {
      continue;
    }

    const q = edgePoint(e, frac);
    const n = edgeNormal(e, q);
    const wallT = wallThicknessAt(ctx, room, e, q, own);
    const m = isClosed(e) ? (((frac % 1) + 1) % 1) * e.len : frac * e.len;

    let center2: V2;
    let delta: number;
    if (!e.arc) {
      const off = wallT / 2 + FLAT_GAP;
      center2 = [q[0] + n[0] * off, q[1] + n[1] * off];
      delta = w / 2;
    } else {
      // chord of the inner face: ends on face + 0.02 on a concave face,
      // midpoint on face + 0.02 on a convex one (spec "Модель стены")
      const c = e.arc.c;
      const axisAng = specAng(q, c);
      const rr: V2 = [q[0] - c[0], q[1] - c[1]];
      const rl = Math.hypot(rr[0], rr[1]) || 1;
      const convex = (n[0] * rr[0] + n[1] * rr[1]) / rl > 0;
      const faceR = Math.hypot(
        q[0] + n[0] * (wallT / 2) - c[0],
        q[1] + n[1] * (wallT / 2) - c[1],
      );
      if (convex) {
        const d0 = dir(axisAng);
        const mR = faceR + FLAT_GAP;
        center2 = [c[0] + mR * d0[0], c[1] + mR * d0[1]];
      } else {
        const eR = faceR - FLAT_GAP;
        const halfAng = Math.asin(Math.min(1, w / 2 / eR));
        const a = dir(axisAng - halfAng);
        const b = dir(axisAng + halfAng);
        center2 = [
          (c[0] + eR * a[0] + c[0] + eR * b[0]) / 2,
          (c[1] + eR * a[1] + c[1] + eR * b[1]) / 2,
        ];
      }
      delta = e.arc.r * Math.asin(Math.min(1, w / 2 / faceR));
    }

    out.push({
      i,
      room: roomId,
      edge: e.id,
      edgeRef: e,
      iv: findInterval(ctx, room, e, q),
      m,
      mRange: [m - delta, m + delta],
      center: [center2[0], levelY + yc, center2[1]],
      normal: n,
      w,
      h,
      y: yc,
      levelY,
      wallT,
      height: room.height,
    });
  }
  return out;
}

/** AuthorEdge referenced by an opening's canonical "room#i" edge id */
function edgeOf(rooms: RoomRec[], edgeId: string): AuthorEdge | undefined {
  const parts = String(edgeId).split("#");
  const i = Number(parts[parts.length - 1]);
  const roomId = parts.slice(0, -1).join("#");
  return rooms.find((r) => r.id === roomId)?.edges.find((x) => x.i === i);
}

export function decalsStage(ctx: Ctx): Issue[] {
  const geos = placeDecals(ctx);
  ctx.decals = geos;
  const issues: Issue[] = [];
  const openings = (ctx.openings ?? []) as any[];
  const props = (ctx.props ?? []) as PropGeo[];
  const rooms = (ctx.rooms ?? []) as RoomRec[];

  const seen: DecalGeo[] = [];
  for (const g of geos) {
    const path = `/decals/${g.i}`;
    const ySpan: [number, number] = [g.y - g.h / 2, g.y + g.h / 2];
    let err: Issue | null = null;

    if (g.noWall) {
      err = {
        code: "DECAL_OFF_WALL",
        stage: STAGE,
        path: `${path}/at`,
        msg: msg("DECAL_OFF_WALL", {
          i: String(g.i),
          kind: "wall",
          edge: String(g.edge),
          d: String(round3(g.d)),
        }),
      };
    } else if (ySpan[0] < -EPS || ySpan[1] > g.height + EPS) {
      const lo = g.h / 2;
      const hi = g.height - g.h / 2;
      err = {
        code: "DECAL_OFF_WALL",
        stage: STAGE,
        path: `${path}/y`,
        msg: msg("DECAL_OFF_WALL", {
          i: String(g.i),
          kind: "y",
          edge: String(g.edge),
          y0: String(round3(ySpan[0])),
          y1: String(round3(ySpan[1])),
          h: String(round3(g.height)),
        }),
        fix: { y: round3(Math.min(hi, Math.max(lo, g.y))) },
      };
    } else if (!isClosed(g.edgeRef) && (g.mRange[0] < -EPS || g.mRange[1] > g.edgeRef.len + EPS)) {
      err = {
        code: "DECAL_OFF_WALL",
        stage: STAGE,
        path,
        msg: msg("DECAL_OFF_WALL", {
          i: String(g.i),
          kind: "m",
          edge: String(g.edge),
          m0: String(round3(g.mRange[0])),
          m1: String(round3(g.mRange[1])),
          a: "0",
          b: String(round3(g.edgeRef.len)),
        }),
      };
    }

    if (!err && !g.noWall) {
      const hitOpening = openings.find((o) => {
        if (!o || o.error) return false;
        if (!overlaps(ySpan, [o.sill, o.sill + o.height])) return false;
        if (!g.iv) return false;
        const oEdge = edgeOf(rooms, o.edge);
        if (!oEdge || o.interval !== g.iv) return false;
        return physicalOverlap(g.iv, g.mRange as [number, number], g.edgeRef, o.mRange as [number, number], oEdge);
      });
      if (hitOpening) {
        err = {
          code: "DECAL_ON_OPENING",
          stage: STAGE,
          path,
          msg: msg("DECAL_ON_OPENING", { i: String(g.i), edge: String(g.edge), opening: String(hitOpening.id) }),
        };
      }
    }

    if (!err && !g.noWall) {
      const other = seen.find(
        (s) =>
          !s.noWall &&
          s.edge === g.edge &&
          s.room === g.room &&
          g.iv &&
          s.iv === g.iv &&
          overlaps(ySpan, [s.y - s.h / 2, s.y + s.h / 2]) &&
          (!isClosed(g.edgeRef)
            ? overlaps(g.mRange as [number, number], s.mRange as [number, number])
            : physicalOverlap(g.iv, g.mRange as [number, number], g.edgeRef, s.mRange as [number, number], s.edgeRef)),
      );
      if (other) {
        err = {
          code: "DECAL_OVERLAP",
          stage: STAGE,
          path,
          msg: msg("DECAL_OVERLAP", { i: String(g.i), other: String(other.i), edge: String(g.edge) }),
        };
      }
    }

    if (err) issues.push(err);
    seen.push(g);
    if (g.noWall) continue;

    // warn: a solid prop standing right against the face covers the decal
    for (const p of props) {
      if (!p.solid || p.room !== g.room) continue;
      if (!overlaps([g.levelY + ySpan[0], g.levelY + ySpan[1]], p.y)) continue;
      let depth = Infinity;
      let mLo = Infinity;
      let mHi = -Infinity;
      for (const corner of obbCorners(p.obb)) {
        const pr = projectOnEdge(corner, g.edgeRef, g.wallT, g.m);
        depth = Math.min(depth, pr.depth);
        mLo = Math.min(mLo, pr.m);
        mHi = Math.max(mHi, pr.m);
      }
      if (depth >= HIDE_GAP) continue;
      if (!overlaps(g.mRange as [number, number], [mLo, mHi])) continue;
      issues.push({
        code: "DECAL_HIDDEN",
        stage: STAGE,
        path,
        msg: msg("DECAL_HIDDEN", {
          i: String(g.i),
          id: p.id,
          d: String(round3(Math.max(0, depth))),
          edge: String(g.edge),
        }),
      });
      break;
    }
  }

  ctx.passport.decals = geos
    .filter((g) => !g.noWall)
    .map((g) => ({ i: g.i, edge: g.edge, center: g.center, normal: g.normal })) as never;
  return issues;
}
