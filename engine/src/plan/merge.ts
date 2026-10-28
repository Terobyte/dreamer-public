import { EPS, SNAP_EPS } from "../geom/vec.js";
import type { V2 } from "../geom/vec.js";
import { wallBody } from "./body.js";
import type { Path64 } from "clipper2-ts";

export interface Side {
  room: string;
  edge: number;
  m: [number, number];
}

export interface Interval {
  from: V2;
  to: V2;
  arc: { c: V2; r: number; sweep?: number } | null;
  sides: Side[];
  thickness: number;
}

export interface LevelPlan {
  intervals: Interval[];
  snaps: { from: V2; to: V2 }[];
  body: Path64[];
}

interface EdgeLike {
  room: string;
  i: number;
  from: V2;
  to: V2;
  arc: { c: V2; r: number; sweep?: number } | null;
  len: number;
}

function dist(a: V2, b: V2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function thicknessOf(room: Record<string, unknown>): number {
  const t = (room as { thickness?: unknown }).thickness;
  if (typeof t === "number" && t > 0) return t;
  return 0.12;
}

export function mergeLevel(roomsIn: Record<string, any>[], level: string): LevelPlan {
  const rooms = (roomsIn as Record<string, any>[]).filter((r) => !r.level || r.level === level);
  const edges: EdgeLike[] = [];
  for (const r of rooms) {
    const list = (r.edges ?? []) as EdgeLike[];
    for (const e of list) edges.push(e);
  }

  // vertex snapping in order: rooms order, edges order (from, then final to).
  // one record per distinct raw vertex: a repeated raw vertex reuses canon silently.
  const canon: V2[] = [];
  const snaps: { from: V2; to: V2 }[] = [];
  const seen = new Map<string, V2>();
  const snapOne = (p: V2): V2 => {
    const pk = `${Math.round(p[0] * 1e9)},${Math.round(p[1] * 1e9)}`;
    const prev = seen.get(pk);
    if (prev) return prev;
    for (const c of canon) {
      if (dist(p, c) <= SNAP_EPS + 1e-9) {
        if (dist(p, c) > EPS) snaps.push({ from: [p[0], p[1]], to: [c[0], c[1]] });
        seen.set(pk, c);
        return c;
      }
    }
    const c: V2 = [p[0], p[1]];
    canon.push(c);
    seen.set(pk, c);
    return c;
  };

  // seed canon in deterministic order
  for (const r of rooms) {
    const list = (r.edges ?? []) as EdgeLike[];
    for (const e of list) snapOne(e.from);
    if (list.length > 0) snapOne((list[list.length - 1] as EdgeLike).to);
  }
  // circle rooms: single closed edge from==to already handled

  const snapped = edges.map((e) => ({
    room: e.room,
    i: e.i,
    from: snapOne(e.from),
    to: snapOne(e.to),
    arc: e.arc,
    len: e.len,
  }));

  const thickByRoom = new Map<string, number>();
  for (const r of rooms) thickByRoom.set(String(r.id), thicknessOf(r));

  const intervals: Interval[] = [];

  // arcs: group by center+radius within SNAP_EPS
  const arcs = snapped.filter((e) => e.arc);
  const arcGroups: (typeof arcs)[] = [];
  for (const e of arcs) {
    let placed = false;
    for (const g of arcGroups) {
      const a0 = g[0].arc!;
      const a1 = e.arc!;
      if (dist(a0.c, a1.c) <= SNAP_EPS + 1e-9 && Math.abs(a0.r - a1.r) <= SNAP_EPS + 1e-9) {
        g.push(e);
        placed = true;
        break;
      }
    }
    if (!placed) arcGroups.push([e]);
  }
  for (const g of arcGroups) {
    // shared-wall case: same endpoints (possibly swapped) -> one interval
    // otherwise keep each arc as its own interval
    let merged = false;
    if (g.length === 2) {
      const [a, b] = g;
      const same =
        (dist(a.from, b.from) <= SNAP_EPS + 1e-9 && dist(a.to, b.to) <= SNAP_EPS + 1e-9) ||
        (dist(a.from, b.to) <= SNAP_EPS + 1e-9 && dist(a.to, b.from) <= SNAP_EPS + 1e-9);
      if (same) {
        const sides: Side[] = g.map((e) => ({ room: e.room, edge: e.i, m: [0, e.len] as [number, number] }));
        const th = Math.max(...g.map((e) => thickByRoom.get(e.room) ?? 0.12));
        intervals.push({ from: [a.from[0], a.from[1]], to: [a.to[0], a.to[1]], arc: { c: [...a.arc!.c] as V2, r: a.arc!.r, sweep: a.arc!.sweep }, sides, thickness: th });
        merged = true;
      }
    }
    if (!merged) {
      for (const e of g) {
        intervals.push({
          from: [e.from[0], e.from[1]],
          to: [e.to[0], e.to[1]],
          arc: { c: [...e.arc!.c] as V2, r: e.arc!.r, sweep: e.arc!.sweep },
          sides: [{ room: e.room, edge: e.i, m: [0, e.len] }],
          thickness: thickByRoom.get(e.room) ?? 0.12,
        });
      }
    }
  }

  // straight edges: collinear grouping
  interface SEdge {
    room: string;
    i: number;
    from: V2;
    to: V2;
    dir: V2;
    len: number;
  }
  const straights: SEdge[] = snapped
    .filter((e) => !e.arc)
    .map((e) => {
      const d: V2 = [e.to[0] - e.from[0], e.to[1] - e.from[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      return { room: e.room, i: e.i, from: e.from, to: e.to, dir: [d[0] / l, d[1] / l] as V2, len: Math.hypot(d[0], d[1]) };
    })
    .filter((e) => e.len > EPS);

  const groups: SEdge[][] = [];
  for (const e of straights) {
    let placed = false;
    for (const g of groups) {
      const ref = g[0];
      const cross = Math.abs(ref.dir[0] * e.dir[1] - ref.dir[1] * e.dir[0]);
      const ang = Math.asin(Math.min(1, cross)) * (180 / Math.PI);
      const effAng = Math.min(ang, 180 - ang);
      if (effAng >= 2 - 1e-9) continue;
      // distance from e endpoints to ref line
      const d0 = Math.abs((e.from[0] - ref.from[0]) * ref.dir[1] - (e.from[1] - ref.from[1]) * ref.dir[0]);
      const d1 = Math.abs((e.to[0] - ref.from[0]) * ref.dir[1] - (e.to[1] - ref.from[1]) * ref.dir[0]);
      if (Math.max(d0, d1) < SNAP_EPS - 1e-9) {
        g.push(e);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([e]);
  }

  for (const g of groups) {
    const ref = g[0];
    const sOf = (p: V2): number => (p[0] - ref.from[0]) * ref.dir[0] + (p[1] - ref.from[1]) * ref.dir[1];
    const bounds: { s: number }[] = [];
    for (const e of g) {
      bounds.push({ s: sOf(e.from) }, { s: sOf(e.to) });
    }
    bounds.sort((a, b) => a.s - b.s);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const s0 = bounds[k].s;
      const s1 = bounds[k + 1].s;
      if (s1 - s0 <= 1e-9) continue;
      const smid = (s0 + s1) / 2;
      const covering = g.filter((e) => {
        const a = sOf(e.from);
        const b = sOf(e.to);
        const lo = Math.min(a, b) - 1e-9;
        const hi = Math.max(a, b) + 1e-9;
        return smid >= lo && smid <= hi;
      });
      if (covering.length === 0) continue;
      // dedupe rooms (keep first edge per room)
      const seen = new Set<string>();
      const sides: Side[] = [];
      for (const e of covering) {
        if (seen.has(e.room)) continue;
        seen.add(e.room);
          const p0: V2 = [ref.from[0] + ref.dir[0] * s0, ref.from[1] + ref.dir[1] * s0];
          const p1: V2 = [ref.from[0] + ref.dir[0] * s1, ref.from[1] + ref.dir[1] * s1];
          // m along edge e own axis
        const elen = e.len || 1;
        const ex = (e.to[0] - e.from[0]) / elen;
        const ez = (e.to[1] - e.from[1]) / elen;
        const m0 = (p0[0] - e.from[0]) * ex + (p0[1] - e.from[1]) * ez;
        const m1 = (p1[0] - e.from[0]) * ex + (p1[1] - e.from[1]) * ez;
        sides.push({ room: e.room, edge: e.i, m: [Math.min(m0, m1), Math.max(m0, m1)] });
      }
      // keep at most 2 sides (shared wall); if more, keep first two in rooms order
      const ordered = sides
        .sort((a, b) => {
          const ia = rooms.findIndex((r) => String(r.id) === a.room);
          const ib = rooms.findIndex((r) => String(r.id) === b.room);
          return ia - ib;
        })
        .slice(0, 2);
      const from: V2 = [ref.from[0] + ref.dir[0] * s0, ref.from[1] + ref.dir[1] * s0];
      const to: V2 = [ref.from[0] + ref.dir[0] * s1, ref.from[1] + ref.dir[1] * s1];
      const th = Math.max(...ordered.map((s) => thickByRoom.get(s.room) ?? 0.12));
      intervals.push({ from, to, arc: null, sides: ordered, thickness: th });
    }
  }

  return { intervals, snaps, body: wallBody(intervals) };
}
