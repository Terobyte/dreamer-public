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

/** spec "Формат SCENE.json" `walls[]`: the pseudo-room of a free wall side.
 *  Its interval has no room of its own, so `side.edge` is the index in
 *  `scene.walls` and `walls#<i>` addresses it in messages and mesh ids. */
export const FREE = "walls";

export interface FreeWall {
  i: number;
  /** `walls#<i>`: the side id, also the mesh id prefix */
  id: string;
  level: string;
  from: V2;
  to: V2;
  thickness: number;
  material: string;
  glass: boolean;
  /** height over the level floor; `h: null` takes the tallest room of the level */
  top: number;
  /** absolute y span */
  y: [number, number];
}

/** The material id for the glass variant of a free wall's own material (both
 *  faces use it, so it is keyed off the wall, not the base material). */
export function glassMaterialId(w: FreeWall): string {
  return `${w.material}$glass:${w.i}`;
}

/** Glass variant ids, keyed by wall index, deconflicted against every
 *  authored material id (F5): an author who happens to own the generated id
 *  keeps their material untouched, and the glass wall gets a further-escaped
 *  id instead of overwriting it. */
export function resolveGlassIds(free: FreeWall[], materialIds: Iterable<string>): Map<number, string> {
  const taken = new Set(materialIds);
  const out = new Map<number, string>();
  for (const w of free) {
    if (!w.glass) continue;
    let id = glassMaterialId(w);
    while (taken.has(id)) id += "$";
    taken.add(id);
    out.set(w.i, id);
  }
  return out;
}

/** `scene.walls` resolved against the levels and the compiled rooms. */
export function freeWalls(
  scene: Record<string, any>,
  rooms: Array<{ level: string; height: number }>,
): FreeWall[] {
  const levels = (scene.levels ?? []) as any[];
  return ((scene.walls ?? []) as any[]).map((w, i) => {
    const level = String(w.level);
    const base = Number(levels.find((l) => String(l?.id) === level)?.y ?? 0);
    const onLevel = rooms.filter((r) => r.level === level);
    const top =
      typeof w.h === "number" ? w.h : onLevel.length > 0 ? Math.max(...onLevel.map((r) => Number(r.height))) : 0;
    return {
      i,
      id: `${FREE}#${i}`,
      level,
      from: [Number(w.from[0]), Number(w.from[1])] as V2,
      to: [Number(w.to[0]), Number(w.to[1])] as V2,
      thickness: typeof w.thickness === "number" && w.thickness > 0 ? w.thickness : 0.12,
      material: String(w.material),
      glass: Boolean(w.glass),
      top,
      y: [base, base + top] as [number, number],
    };
  });
}

/** The four corners of a free wall's footprint (its axis offset both ways). */
export function freeWallPoly(w: FreeWall): V2[] {
  const dx = w.to[0] - w.from[0];
  const dz = w.to[1] - w.from[1];
  const l = Math.hypot(dx, dz) || 1;
  const n: V2 = [(-dz / l) * (w.thickness / 2), (dx / l) * (w.thickness / 2)];
  return [
    [w.from[0] + n[0], w.from[1] + n[1]],
    [w.to[0] + n[0], w.to[1] + n[1]],
    [w.to[0] - n[0], w.to[1] - n[1]],
    [w.from[0] - n[0], w.from[1] - n[1]],
  ];
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

export function mergeLevel(
  roomsIn: Record<string, any>[],
  level: string,
  walls: FreeWall[] = [],
): LevelPlan {
  const rooms = (roomsIn as Record<string, any>[]).filter((r) => !r.level || r.level === level);
  const edges: EdgeLike[] = [];
  for (const r of rooms) {
    const list = (r.edges ?? []) as EdgeLike[];
    for (const e of list) edges.push(e);
  }
  // free walls join the merge as ordinary straight edges of the pseudo-room
  // `walls`, so they snap, split and share intervals like any room wall; they
  // come last, which keeps the interval indices of the rooms unchanged
  for (const w of walls.filter((x) => x.level === level)) {
    edges.push({
      room: FREE,
      i: w.i,
      from: w.from,
      to: w.to,
      arc: null,
      len: Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1]),
    });
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
      // strictly closer than snap_eps (a gap of exactly 0.10 is drift, not a snap)
      if (dist(p, c) < SNAP_EPS - 1e-9) {
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
    // authored ends: side `m` is measured from shape[i], not from its snap
    ofrom: e.from,
    oto: e.to,
  }));

  const thickByRoom = new Map<string, number>();
  for (const r of rooms) thickByRoom.set(String(r.id), thicknessOf(r));
  for (const w of walls) thickByRoom.set(w.id, w.thickness);
  // a side of the pseudo-room `walls` is one wall of `scene.walls`, so its
  // thickness hangs off the edge index rather than off the room id
  const thickOf = (s: { room: string; edge: number }): number =>
    thickByRoom.get(s.room === FREE ? `${FREE}#${s.edge}` : s.room) ?? 0.12;
  // the pseudo-room has no place in `rooms`: order it after the real ones, so
  // a shared interval still takes its id and its `m` from the room side
  const roomOrder = (room: string): number => {
    const k = rooms.findIndex((r) => String(r.id) === room);
    return k < 0 ? rooms.length : k;
  };

  const intervals: Interval[] = [];

  // arcs: group by center+radius within SNAP_EPS
  const arcs = snapped.filter((e) => e.arc);
  const arcGroups: (typeof arcs)[] = [];
  for (const e of arcs) {
    let placed = false;
    for (const g of arcGroups) {
      const a0 = g[0].arc!;
      const a1 = e.arc!;
      if (dist(a0.c, a1.c) < SNAP_EPS - 1e-9 && Math.abs(a0.r - a1.r) < SNAP_EPS - 1e-9) {
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
      // same ends are not enough: two semicircles share both ends over opposite halves
      const midOf = (e: typeof a): V2 => {
        const c = e.arc!.c;
        const t = Math.atan2(e.from[0] - c[0], e.from[1] - c[1]) + (e.arc!.sweep ?? 0) / 2;
        return [c[0] + e.arc!.r * Math.sin(t), c[1] + e.arc!.r * Math.cos(t)];
      };
      const same =
        ((dist(a.from, b.from) <= SNAP_EPS + 1e-9 && dist(a.to, b.to) <= SNAP_EPS + 1e-9) ||
          (dist(a.from, b.to) <= SNAP_EPS + 1e-9 && dist(a.to, b.from) <= SNAP_EPS + 1e-9)) &&
        dist(midOf(a), midOf(b)) <= SNAP_EPS + 1e-9;
      if (same) {
        const sides: Side[] = g.map((e) => ({ room: e.room, edge: e.i, m: [0, e.len] as [number, number] }));
        const th = Math.max(...g.map((e) => thickByRoom.get(e.room) ?? 0.12));
        intervals.push({ from: [a.from[0], a.from[1]], to: [a.to[0], a.to[1]], arc: { c: [...a.arc!.c] as V2, r: a.arc!.r, sweep: a.arc!.sweep }, sides, thickness: th });
        merged = true;
      }
    }
    if (!merged && g.length > 1) {
      intervals.push(...splitArcs(g, rooms, thickByRoom));
      merged = true;
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
    ofrom: V2;
    oto: V2;
  }
  const straights: SEdge[] = snapped
    .filter((e) => !e.arc)
    .map((e) => {
      const d: V2 = [e.to[0] - e.from[0], e.to[1] - e.from[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      return { room: e.room, i: e.i, from: e.from, to: e.to, dir: [d[0] / l, d[1] / l] as V2, len: Math.hypot(d[0], d[1]), ofrom: e.ofrom, oto: e.oto };
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
      // gap between the lines where the two edges overlap (it is linear along
      // the line, so its ends bound it); edges that do not overlap compare
      // their whole length
      const off = (p: V2): number => (p[0] - ref.from[0]) * ref.dir[1] - (p[1] - ref.from[1]) * ref.dir[0];
      const along = (p: V2): number => (p[0] - ref.from[0]) * ref.dir[0] + (p[1] - ref.from[1]) * ref.dir[1];
      const sa = along(e.from);
      const sb = along(e.to);
      const lo = Math.max(Math.min(sa, sb), Math.min(along(ref.from), along(ref.to)));
      const hi = Math.min(Math.max(sa, sb), Math.max(along(ref.from), along(ref.to)));
      const gapAt = (x: number): number =>
        Math.abs(off(e.from) + ((off(e.to) - off(e.from)) * (x - sa)) / (sb - sa || 1));
      const gap = hi - lo > EPS ? Math.max(gapAt(lo), gapAt(hi)) : Math.max(Math.abs(off(e.from)), Math.abs(off(e.to)));
      if (gap < SNAP_EPS - 1e-9) {
        g.push(e);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([e]);
  }

  // a shared group lays its members onto the first one's line: a vertex moved
  // that way (a T-junction) moves for the walls that meet it as well, or a
  // gap opens at the junction
  const moved = new Map<V2, V2>();
  for (const g of groups) {
    if (g.length < 2) continue;
    const ref = g[0];
    for (const e of g.slice(1)) {
      for (const p of [e.from, e.to]) {
        const off = (p[0] - ref.from[0]) * ref.dir[1] - (p[1] - ref.from[1]) * ref.dir[0];
        if (Math.abs(off) > EPS && !moved.has(p)) moved.set(p, [p[0] - off * ref.dir[1], p[1] + off * ref.dir[0]]);
      }
    }
  }
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k];
    if (g.length !== 1) continue;
    const e = g[0];
    const from = moved.get(e.from) ?? e.from;
    const to = moved.get(e.to) ?? e.to;
    if (from === e.from && to === e.to) continue;
    const l = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    groups[k] = [{ ...e, from, to, dir: [(to[0] - from[0]) / l, (to[1] - from[1]) / l], len: l }];
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
        // m along the authored edge from its shape[i], within its length
        const olen = Math.hypot(e.oto[0] - e.ofrom[0], e.oto[1] - e.ofrom[1]) || 1;
        const ex = (e.oto[0] - e.ofrom[0]) / olen;
        const ez = (e.oto[1] - e.ofrom[1]) / olen;
        const mOf = (p: V2): number =>
          Math.min(olen, Math.max(0, (p[0] - e.ofrom[0]) * ex + (p[1] - e.ofrom[1]) * ez));
        const m0 = mOf(p0);
        const m1 = mOf(p1);
        sides.push({ room: e.room, edge: e.i, m: [Math.min(m0, m1), Math.max(m0, m1)] });
      }
      // keep at most 2 sides (shared wall); if more, keep first two in rooms order
      const ordered = sides.sort((a, b) => roomOrder(a.room) - roomOrder(b.room)).slice(0, 2);
      const from: V2 = [ref.from[0] + ref.dir[0] * s0, ref.from[1] + ref.dir[1] * s0];
      const to: V2 = [ref.from[0] + ref.dir[0] * s1, ref.from[1] + ref.dir[1] * s1];
      const th = Math.max(...ordered.map((s) => thickOf(s)));
      intervals.push({ from, to, arc: null, sides: ordered, thickness: th });
    }
  }

  return { intervals, snaps, body: wallBody(intervals) };
}

interface ArcEdge {
  room: string;
  i: number;
  from: V2;
  to: V2;
  arc: { c: V2; r: number; sweep?: number } | null;
  len: number;
}

/** arcs on one circle, split like collinear walls: boundaries at every arc end,
 *  one interval per covered cell with the
 *  rooms whose edges cover it; `m` stays in each author edge's own coordinates */
function splitArcs(g: ArcEdge[], rooms: Record<string, any>[], thickByRoom: Map<string, number>): Interval[] {
  const TAU = 2 * Math.PI;
  const wrap = (x: number): number => ((x % TAU) + TAU) % TAU;
  const c = g[0].arc!.c;
  const r = g[0].arc!.r;
  const ang = (p: V2): number => Math.atan2(p[0] - c[0], p[1] - c[1]);
  const pt = (a: number): V2 => [c[0] + r * Math.sin(a), c[1] + r * Math.cos(a)];
  // coverage as a start angle and a positive span; a closed edge starts at 0
  const cov = g.map((e) => {
    if (dist(e.from, e.to) < EPS) return { e, a: 0, span: TAU, closed: true, sw: TAU };
    const sw = e.arc!.sweep ?? 0;
    const a0 = ang(e.from);
    return sw >= 0 ? { e, a: wrap(a0), span: sw, closed: false, sw } : { e, a: wrap(a0 + sw), span: -sw, closed: false, sw };
  });
  // a closed edge adds no boundary: a shared wall may run across its seam, and
  // its side `m` then runs past `len` (a part is [a, b] with b ≤ a + len)
  const raw = cov.flatMap((k) => (k.closed ? [] : [k.a, wrap(k.a + k.span)]));
  if (raw.length === 0) raw.push(0);
  raw.sort((x, y) => x - y);
  const bounds: number[] = [];
  for (const b of raw) if (bounds.length === 0 || b - bounds[bounds.length - 1] > 1e-9) bounds.push(b);
  if (bounds.length > 1 && bounds[0] + TAU - bounds[bounds.length - 1] <= 1e-9) bounds.pop();
  const order = (room: string): number => rooms.findIndex((x) => String(x.id) === room);
  const out: Interval[] = [];
  for (let k = 0; k < bounds.length; k++) {
    const lo = bounds[k];
    const hi = k + 1 < bounds.length ? bounds[k + 1] : bounds[0] + TAU;
    const mid = (lo + hi) / 2;
    const covering = cov.filter((x) => wrap(mid - x.a) < x.span).sort((x, y) => order(x.e.room) - order(y.e.room));
    const seen = new Set<string>();
    const sides: Side[] = [];
    for (const x of covering) {
      if (seen.has(x.e.room)) continue;
      seen.add(x.e.room);
      // m from the author start along the author direction, on its own radius
      const rr = x.e.arc!.r;
      const relLo = wrap(lo - x.a);
      const m0 = x.sw >= 0 ? relLo * rr : (x.span - relLo) * rr;
      const m1 = x.sw >= 0 ? m0 + (hi - lo) * rr : m0 - (hi - lo) * rr;
      sides.push({ room: x.e.room, edge: x.e.i, m: [Math.min(m0, m1), Math.max(m0, m1)] });
      if (sides.length === 2) break;
    }
    if (sides.length === 0) continue;
    const first = covering[0];
    const full = bounds.length === 1;
    const pos = first.sw >= 0;
    out.push({
      from: pt(pos ? lo : hi),
      to: full ? pt(lo) : pt(pos ? hi : lo),
      arc: { c: [c[0], c[1]], r, sweep: pos ? hi - lo : -(hi - lo) },
      sides,
      thickness: Math.max(...sides.map((s) => thickByRoom.get(s.room) ?? 0.12)),
    });
  }
  return out;
}

