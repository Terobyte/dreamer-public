import type { Ctx } from "../ctx.js";
import type { Issue } from "../types.js";
import { EPS, SNAP_EPS } from "../geom/vec.js";
import type { V2 } from "../geom/vec.js";
import type { Interval } from "../plan/merge.js";
import { arcFrac } from "../geom/arc.js";
import { msg } from "../report/messages.js";
import { autoGapHeight } from "../schema/validate.js";

export interface OpeningGeo {
  id: string;
  kind: string;
  interval: Interval;
  intervalLevel: string;
  intervalIndex: number;
  edge: string;
  m: number;
  mRange: [number, number];
  center: V2;
  axis: V2;
  rooms: string[];
  ends: [V2, V2] /* chord endpoints on the wall axis */;
  sill: number;
  height: number;
  width: number;
  thickness: number;
  normalIn: V2;
  swing: string | null;
  hingeAt: V2 | null;
  hinge: "left" | "right" | null;
  corridor: V2[];
  flatten: V2[] | null;
  sector: V2[] | null;
  leafOpen: boolean;
  error?: Issue;
}

interface AuthorEdge {
  id: string;
  room: string;
  i: number;
  from: V2;
  to: V2;
  arc: { c: V2; r: number; sweep?: number } | null;
  len: number;
  normalIn: V2;
}

const TAU = Math.PI * 2;

function wrapTau(x: number): number {
  return ((x % TAU) + TAU) % TAU;
}

function specAng(p: V2, c: V2): number {
  return Math.atan2(p[0] - c[0], p[1] - c[1]);
}

function isClosed(e: AuthorEdge): boolean {
  return !!e.arc && Math.hypot(e.from[0] - e.to[0], e.from[1] - e.to[1]) < EPS;
}

function edgePoint(e: AuthorEdge, frac: number): { p: V2; dir: V2 } {
  if (!e.arc) {
    const dx = e.to[0] - e.from[0];
    const dz = e.to[1] - e.from[1];
    const l = Math.hypot(dx, dz) || 1;
    return { p: [e.from[0] + dx * frac, e.from[1] + dz * frac], dir: [dx / l, dz / l] };
  }
  const c = e.arc.c;
  const R = e.arc.r;
  if (isClosed(e)) {
    const a = frac * TAU;
    return { p: [c[0] + R * Math.sin(a), c[1] + R * Math.cos(a)], dir: [Math.cos(a), -Math.sin(a)] };
  }
  const sweep = e.arc.sweep ?? 0;
  const a0 = specAng(e.from, c);
  const ang = a0 + sweep * frac;
  const s = sweep >= 0 ? 1 : -1;
  return { p: [c[0] + R * Math.sin(ang), c[1] + R * Math.cos(ang)], dir: [s * Math.cos(ang), -s * Math.sin(ang)] };
}

function edgeNormal(e: AuthorEdge, p: V2): V2 {
  if (!e.arc) return [e.normalIn[0], e.normalIn[1]];
  if (isClosed(e)) {
    // closed circle: the room is inside, inward normal points to the center
    const c = e.arc.c;
    const dx = c[0] - p[0];
    const dz = c[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  }
  const c = e.arc.c;
  const R = e.arc.r || 1;
  let n: V2 = [(p[0] - c[0]) / R, (p[1] - c[1]) / R];
  // orientation from the arc midpoint, where the radial is parallel to
  // `normalIn`; at the ends of a semicircle the radial is perpendicular to it
  const pm = edgePoint(e, 0.5).p;
  if ((pm[0] - c[0]) * e.normalIn[0] + (pm[1] - c[1]) * e.normalIn[1] < 0) n = [-n[0], -n[1]];
  const l = Math.hypot(n[0], n[1]) || 1;
  return [n[0] / l, n[1] / l];
}

function fracAtPoint(e: AuthorEdge, p: V2): number {
  if (!e.arc) {
    const dx = e.to[0] - e.from[0];
    const dz = e.to[1] - e.from[1];
    const l2 = dx * dx + dz * dz || 1;
    const f = ((p[0] - e.from[0]) * dx + (p[1] - e.from[1]) * dz) / l2;
    return Math.min(1, Math.max(0, f));
  }
  const c = e.arc.c;
  if (isClosed(e)) return wrapTau(specAng(p, c)) / TAU;
  const sweep = e.arc.sweep ?? 0;
  if (Math.abs(sweep) < EPS) return 0;
  return arcFrac(wrapTau(specAng(p, c) - specAng(e.from, c)), sweep);
}

function fracAtAz(e: AuthorEdge, azDeg: number): number {
  const rad = (azDeg * Math.PI) / 180;
  if (isClosed(e)) return wrapTau(rad) / TAU;
  const sweep = e.arc?.sweep ?? 0;
  if (Math.abs(sweep) < EPS) return 0;
  return arcFrac(wrapTau(rad - specAng(e.from, e.arc!.c)), sweep);
}

function segClosest(p: V2, a: V2, b: V2): { d: number; q: V2 } {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  const q: V2 = [a[0] + dx * t, a[1] + dz * t];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q };
}

function arcSweepOf(iv: Interval): number {
  if (typeof iv.arc?.sweep === "number") return iv.arc.sweep;
  const c = iv.arc!.c;
  const a0 = specAng(iv.from, c);
  const a1 = specAng(iv.to, c);
  let s = a1 - a0;
  while (s > Math.PI) s -= TAU;
  while (s < -Math.PI) s += TAU;
  return s;
}

function discretizeInterval(iv: Interval): V2[] {
  if (!iv.arc) return [iv.from, iv.to];
  const c = iv.arc.c;
  const r = iv.arc.r;
  const full = Math.hypot(iv.from[0] - iv.to[0], iv.from[1] - iv.to[1]) < 1e-6;
  const a0 = specAng(iv.from, c);
  const sweep = full && Math.abs(arcSweepOf(iv)) < EPS ? TAU : arcSweepOf(iv);
  const total = Math.abs(r * sweep);
  const n = Math.max(1, Math.ceil(total / 0.25));
  const pts: V2[] = [];
  for (let k = 0; k <= n; k++) {
    const ang = a0 + (sweep * k) / n;
    pts.push([c[0] + r * Math.sin(ang), c[1] + r * Math.cos(ang)]);
  }
  pts[0] = [iv.from[0], iv.from[1]];
  if (!full) pts[pts.length - 1] = [iv.to[0], iv.to[1]];
  return pts;
}

function closestOnArcInterval(p: V2, iv: Interval): { d: number; q: V2 } {
  const c = iv.arc!.c;
  const r = iv.arc!.r;
  const full = Math.hypot(iv.from[0] - iv.to[0], iv.from[1] - iv.to[1]) < 1e-6;
  const ang = specAng(p, c);
  let angAtF = ang;
  if (!full) {
    const a0 = specAng(iv.from, c);
    const sweep = arcSweepOf(iv);
    angAtF = a0 + sweep * arcFrac(wrapTau(ang - a0), sweep);
  }
  const q: V2 = [c[0] + r * Math.sin(angAtF), c[1] + r * Math.cos(angAtF)];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q };
}

function closestOnInterval(p: V2, iv: Interval): { d: number; q: V2 } {
  if (iv.arc) return closestOnArcInterval(p, iv);
  const pts = discretizeInterval(iv);
  let best = { d: Infinity, q: pts[0] as V2 };
  for (let k = 0; k + 1 < pts.length; k++) {
    const c = segClosest(p, pts[k], pts[k + 1]);
    if (c.d < best.d) best = c;
  }
  return best;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function resolveOpenings(ctx: Ctx): OpeningGeo[] {
  const scene = ctx.scene as any;
  const levels = (ctx as any).levels as Map<string, { intervals: Interval[] }>;
  const rooms: Array<{ id: string; level: string; height: number; edges: AuthorEdge[] }> = (ctx as any).rooms ?? [];
  const order = new Map<string, number>(rooms.map((r, i) => [r.id, i]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const edgeOf = (roomId: string, i: number): AuthorEdge | undefined =>
    roomById.get(roomId)?.edges.find((e) => e.i === i);

  const byLevel = new Map<string, Array<{ iv: Interval; idx: number }>>();
  if (levels) {
    for (const [lvl, plan] of levels) {
      plan.intervals.forEach((iv, idx) => {
        const list = byLevel.get(lvl) ?? [];
        list.push({ iv, idx });
        byLevel.set(lvl, list);
      });
    }
  }

  const out: OpeningGeo[] = [];
  const list: any[] = scene.openings ?? [];

  list.forEach((o: any, oi: number) => {
    const path = `/openings/${oi}`;
    const fail = (code: "OPENING_NO_WALL" | "OPENING_OFF_EDGE" | "OPENING_OVERLAP" | "OPENING_TOO_HIGH" | "OPENING_NO_OUTSIDE",
      params: Record<string, string>, fix?: Record<string, unknown>): OpeningGeo => {
      const g = { id: String(o.id), kind: String(o.kind), rooms: [] as string[] } as OpeningGeo;
      g.error = { code: code as never, stage: "openings", path, msg: msg(code as never, { path, id: String(o.id), ...params }), ...(fix ? { fix } : {}) };
      out.push(g);
      return g;
    };
    const reject = (error: Issue): void => {
      out.push({ id: String(o.id), kind: String(o.kind), rooms: [] as string[], error } as OpeningGeo);
    };

    const width = o.width as number;
    let height = o.height as number;
    const sill = o.sill as number;

    // locate: riding room, edge, m, center, axis
    let rideRoom = "";
    let rideEdge: AuthorEdge | undefined;
    let m = 0;
    let center: V2 = [0, 0];
    let axis: V2 = [1, 0];
    let level = "";
    let picked: Interval | undefined;
    let pickedIdx = -1;

    if (o.on && typeof o.on === "object") {
      rideRoom = o.on.room as string;
      rideEdge = edgeOf(rideRoom, o.on.edge as number);
      if (!rideEdge) return;
      level = roomById.get(rideRoom)?.level ?? "";
      const L = rideEdge.len;
      let frac = 0;
      if (typeof o.on.t === "number") frac = o.on.t;
      else if (typeof o.on.m === "number") frac = L > 0 ? (isClosed(rideEdge) ? (((o.on.m % L) + L) % L) / L : o.on.m / L) : 0;
      else if (typeof o.on.az === "number") frac = fracAtAz(rideEdge, o.on.az);
      m = frac * L;
      if (isClosed(rideEdge)) m = ((m % L) + L) % L;
      const at = edgePoint(rideEdge, frac);
      center = at.p;
      axis = at.dir;
    } else if (Array.isArray(o.at)) {
      const p: V2 = [o.at[0], o.at[1]];
      let best = { d: Infinity, q: p as V2, iv: undefined as Interval | undefined, idx: -1, lvl: "" };
      if (levels) {
        for (const [lvl, plan] of levels) {
          plan.intervals.forEach((iv, idx) => {
            const c = closestOnInterval(p, iv);
            if (c.d < best.d - 1e-12) best = { d: c.d, q: c.q, iv, idx, lvl };
          });
        }
      }
      if (!best.iv || best.d >= SNAP_EPS) {
        const addr = best.iv ? sideAddr(best.iv, order) : "—";
        fail("OPENING_NO_WALL", { d: String(round3(best.d)), at: addr },
          { at: [round3(best.q[0]), round3(best.q[1])] });
        return;
      }
      picked = best.iv;
      pickedIdx = best.idx;
      level = best.lvl;
      const sideRooms = [...new Set(picked.sides.map((s) => s.room))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      rideRoom = sideRooms[0];
      const side = picked.sides.find((s) => s.room === rideRoom)!;
      rideEdge = edgeOf(rideRoom, side.edge);
      if (!rideEdge) return;
      const frac = fracAtPoint(rideEdge, best.q);
      m = frac * rideEdge.len;
      const at = edgePoint(rideEdge, frac);
      center = at.p;
      axis = at.dir;
    } else {
      return;
    }

    const closed = rideEdge.arc && isClosed(rideEdge);
    const R = rideEdge.arc ? rideEdge.arc.r : 0;
    // the chord half-width must stay inside the circle: `asin` is undefined past
    // R, so this bound takes no EPS slack — a hair over the diameter is an error,
    // not a rounding artifact
    if (rideEdge.arc && width / 2 > R) {
      fail("OPENING_OFF_EDGE", {
        m0: String(round3(m - width / 2)),
        m1: String(round3(m + width / 2)),
        edge: `${rideRoom}#${rideEdge.i}`,
        a: "0",
        b: String(round3(2 * R)),
      });
      return;
    }
    // clamp guards the exact width = 2R case, where the division can land a hair
    // above 1 and make `asin` return NaN
    const half = rideEdge.arc ? R * Math.asin(Math.min(1, width / 2 / R)) : width / 2;
    let mRange: [number, number] = [m - half, m + half];

    // containing interval + rooms
    if (!picked) {
      const lvl = roomById.get(rideRoom)?.level ?? level;
      const cands = (byLevel.get(lvl) ?? []).filter(({ iv }) =>
        iv.sides.some((s) => s.room === rideRoom && s.edge === rideEdge!.i));
      if (closed && cands.length <= 1) {
        const hit = cands[0];
        if (!hit) return;
        picked = hit.iv;
        pickedIdx = hit.idx;
        level = lvl;
      } else if (closed) {
        // a circle split by a shared arc: the opening must sit inside one part
        const L = rideEdge.len;
        const side = (c: { iv: Interval }) => c.iv.sides.find((s) => s.room === rideRoom && s.edge === rideEdge!.i)!;
        const hit = cands.find((c) => fitsCyclic(side(c).m, mRange, L));
        if (!hit) {
          const near = cands.find((c) => fitsCyclic(side(c).m, [mRange[0], mRange[0]], L)) ?? cands[0];
          fail("OPENING_OFF_EDGE",
            { m0: String(round3(mRange[0])), m1: String(round3(mRange[1])), edge: `${rideRoom}#${rideEdge.i}`, a: String(round3(side(near).m[0])), b: String(round3(side(near).m[1])) });
          return;
        }
        picked = hit.iv;
        pickedIdx = hit.idx;
        level = lvl;
      } else {
        // the authored edge bounds first: a snapped interval may reach past them
        if (mRange[0] < -1e-6 || mRange[1] > rideEdge.len + 1e-6) {
          fail("OPENING_OFF_EDGE",
            { m0: String(round3(mRange[0])), m1: String(round3(mRange[1])), edge: `${rideRoom}#${rideEdge.i}`, a: "0", b: String(round3(rideEdge.len)) });
          return;
        }
        let hit: { iv: Interval; idx: number } | undefined;
        let addr = "";
        let addrRange: [number, number] = [0, 0];
        let bestDist = Infinity;
        for (const c of cands) {
          const side = c.iv.sides.find((s) => s.room === rideRoom && s.edge === rideEdge!.i)!;
          const [a, b] = side.m;
          addr = `${rideRoom}#${rideEdge.i}`;
          if (a - 1e-6 <= mRange[0] && mRange[1] <= b + 1e-6) { hit = c; break; }
          const dd = mRange[0] < a ? a - mRange[0] : mRange[1] - b;
          if (dd < bestDist) { bestDist = dd; addrRange = [a, b]; }
        }
        if (!hit) {
          fail("OPENING_OFF_EDGE",
            { m0: String(round3(mRange[0])), m1: String(round3(mRange[1])), edge: `${rideRoom}#${rideEdge.i}`, a: String(round3(addrRange[0])), b: String(round3(addrRange[1])) });
          return;
        }
        picked = hit.iv;
        pickedIdx = hit.idx;
        level = lvl;
      }
    } else {
      // `at` case: verify the picked interval covers mRange in riding-edge coords
      {
        const side = picked.sides.find((s) => s.room === rideRoom && s.edge === rideEdge!.i);
        const covers = side && (closed
          ? fitsCyclic(side.m, mRange, rideEdge.len)
          : side.m[0] - 1e-6 <= mRange[0] && mRange[1] <= side.m[1] + 1e-6);
        if (!covers) {
          const a = side ? side.m[0] : 0;
          const b = side ? side.m[1] : 0;
          fail("OPENING_OFF_EDGE",
            { m0: String(round3(mRange[0])), m1: String(round3(mRange[1])), edge: `${rideRoom}#${rideEdge.i}`, a: String(round3(a)), b: String(round3(b)) });
          return;
        }
      }
    }

    const roomsList = [...new Set(picked.sides.map((s) => s.room))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    // the leaf can only open into a room the opening joins; an invalid opening
    // takes part in nothing downstream, not even overlap checks of later ones
    const sw = o.leaf?.swing;
    if (typeof sw === "string" && !roomsList.includes(sw)) {
      const p = `${path}/leaf/swing`;
      reject({ code: "REF_UNKNOWN", stage: "openings", path: p, msg: msg("REF_UNKNOWN", { path: p, kind: "комната проёма", v: sw, have: roomsList.join(", ") }) });
      return;
    }
    // a default gap height is the lower ceiling of the sides actually resolved
    if (autoGapHeight.has(o)) {
      const hs = roomsList.map((r) => roomById.get(r)?.height).filter((h): h is number => typeof h === "number" && h > 0);
      if (hs.length > 0) height = o.height = Math.min(...hs);
    }
    // canonicalize to the first room in scene order so a shared wall reports
    // the same edge/m/rooms regardless of which side `on` named
    const canonRoom = roomsList[0];
    if (canonRoom !== rideRoom) {
      const canonSide = picked.sides.find((s) => s.room === canonRoom);
      const canonEdge = canonSide ? edgeOf(canonRoom, canonSide.edge) : undefined;
      if (canonEdge) {
        const frac = fracAtPoint(canonEdge, center);
        rideRoom = canonRoom;
        rideEdge = canonEdge;
        m = frac * canonEdge.len;
        const at = edgePoint(canonEdge, frac);
        center = at.p;
        axis = at.dir;
        mRange = [m - half, m + half];
      }
    }

    // overlap: same interval, intersecting ranges (later opening reported);
    // on a closed circle the mRange may wrap past m=0/L, so split and compare cyclically
    const key = `${level}:${pickedIdx}`;
    for (const g of out) {
      if (g.error || `${g.intervalLevel}:${g.intervalIndex}` !== key) continue;
      const gEdge = edgeOf(g.rooms[0], edgeIndexOf(g))!;
      let hit: boolean;
      if (rideEdge.arc && isClosed(rideEdge) && gEdge.arc && isClosed(gEdge)) {
        hit = segsHit(splitWrapped(mRange, rideEdge.len), splitWrapped(g.mRange, gEdge.len));
      } else {
        const A = sRange(picked, pickedIdx, level, center, mRange, rideEdge, rideRoom);
        const B = sRange(g.interval, g.intervalIndex, g.intervalLevel, g.center, g.mRange, gEdge, g.rooms[0]);
        hit = A[0] < B[1] - 1e-9 && B[0] < A[1] - 1e-9;
      }
      if (hit) {
        fail("OPENING_OVERLAP", { other: String(g.id), edge: `${rideRoom}#${rideEdge.i}` });
        return;
      }
    }

    // too high
    const ceils = roomsList.map((r) => ({ r, h: roomById.get(r)?.height as number })).filter((x) => typeof x.h === "number" && x.h > 0);
    const low = ceils.length > 0 ? ceils.reduce((a, b) => (b.h < a.h ? b : a)) : undefined;
    if (low && sill + height > low.h + EPS) {
      // rounded down so the fix stays under the ceiling; a sill at (or within
      // 1 mm of) the ceiling has no valid positive `height` to suggest
      const fixH = Math.floor((low.h - sill) * 1000 + 1e-9) / 1000;
      fail("OPENING_TOO_HIGH", { v: String(round3(sill + height)), room: low.r, h: String(round3(low.h)) },
        fixH > 0 ? { height: fixH } : undefined);
      return;
    }

    // outside
    if (roomsList.length < 2 && !o.outside) {
      fail("OPENING_NO_OUTSIDE", { edge: `${rideRoom}#${rideEdge.i}` });
      return;
    }

    // the author edge may sit off the merged axis (snapped corners): put the
    // opening on the wall it cuts, i.e. the picked interval's line or circle
    const iv = picked;
    const onAxis = (p: V2): V2 => {
      if (iv.arc) {
        const c = iv.arc.c;
        const l = Math.hypot(p[0] - c[0], p[1] - c[1]) || 1;
        return [c[0] + ((p[0] - c[0]) * iv.arc.r) / l, c[1] + ((p[1] - c[1]) * iv.arc.r) / l];
      }
      const dx = iv.to[0] - iv.from[0];
      const dz = iv.to[1] - iv.from[1];
      const l2 = dx * dx + dz * dz || 1;
      const k = ((p[0] - iv.from[0]) * dx + (p[1] - iv.from[1]) * dz) / l2;
      return [iv.from[0] + dx * k, iv.from[1] + dz * k];
    };
    center = onAxis(center);
    const n = edgeNormal(rideEdge, center);
    const th = picked.thickness;
    // chord endpoints on the wall axis (on arcs they lie on the arc, not on the
    // tangent line); corridor runs along the chord to both sides of the axis
    const L = rideEdge.len || 1;
    const f0 = closed01Edge(rideEdge, mRange[0] / L);
    const f1 = closed01Edge(rideEdge, mRange[1] / L);
    const ends: [V2, V2] = [onAxis(edgePoint(rideEdge, f0).p), onAxis(edgePoint(rideEdge, f1).p)];
    const hd = 0.8;
    const cx = (ends[0][0] + ends[1][0]) / 2;
    const cz = (ends[0][1] + ends[1][1]) / 2;
    const edx = ends[1][0] - ends[0][0];
    const edz = ends[1][1] - ends[0][1];
    const elen = Math.hypot(edx, edz);
    const ux = elen > 1e-12 ? edx / elen : axis[0];
    const uz = elen > 1e-12 ? edz / elen : axis[1];
    const hl = elen > 1e-12 ? elen / 2 : width / 2;
    const px: V2 = [uz, -ux];
    const corridor: V2[] = [
      [cx + ux * hl + px[0] * hd, cz + uz * hl + px[1] * hd],
      [cx - ux * hl + px[0] * hd, cz - uz * hl + px[1] * hd],
      [cx - ux * hl - px[0] * hd, cz - uz * hl - px[1] * hd],
      [cx + ux * hl - px[0] * hd, cz + uz * hl - px[1] * hd],
    ];

    // spec: on an arc the body polyline between the chord ends is replaced by
    // the chord, then the cut goes along the chord. `flatten` removes the arc
    // body between the two flat jambs (planes across the chord at its ends,
    // not the radial end caps of the arc band); the cut itself stays the chord
    // rectangle (see `cutPath` in the stage).
    let flatten: V2[] | null = null;
    if (rideEdge.arc) {
      const hd2 = th / 2 + EPS;
      const closedE = isClosed(rideEdge);
      let delta = f1 - f0;
      if (closedE && delta < 0) delta += 1;
      const totalLen = Math.abs(delta) * L;
      const nSeg = Math.max(2, Math.ceil(totalLen / 0.25));
      // depth range of the arc band across the chord; the margin covers the
      // wall face past the radial cap that still lies between the jambs
      let pMin = -hd2;
      let pMax = hd2;
      for (let k = 0; k <= nSeg; k++) {
        const raw = f0 + (delta * k) / nSeg;
        const frac = closedE ? ((raw % 1) + 1) % 1 : raw;
        const pt = edgePoint(rideEdge, frac).p;
        const nn = edgeNormal(rideEdge, pt);
        for (const s of [hd2, -hd2]) {
          const d = (pt[0] + nn[0] * s - cx) * px[0] + (pt[1] + nn[1] * s - cz) * px[1];
          pMin = Math.min(pMin, d);
          pMax = Math.max(pMax, d);
        }
      }
      pMin -= hd2;
      pMax += hd2;
      flatten = [
        [cx + ux * hl + px[0] * pMax, cz + uz * hl + px[1] * pMax],
        [cx - ux * hl + px[0] * pMax, cz - uz * hl + px[1] * pMax],
        [cx - ux * hl + px[0] * pMin, cz - uz * hl + px[1] * pMin],
        [cx + ux * hl + px[0] * pMin, cz + uz * hl + px[1] * pMin],
      ];
    }

    out.push({
      id: String(o.id),
      kind: String(o.kind),
      interval: picked,
      intervalLevel: level,
      intervalIndex: pickedIdx,
      edge: `${rideRoom}#${rideEdge.i}`,
      m,
      mRange,
      center,
      axis,
      rooms: roomsList,
      ends,
      sill,
      height,
      width,
      thickness: th,
      normalIn: n,
      swing: null,
      hingeAt: null,
      hinge: null,
      corridor,
      flatten,
      sector: null,
      leafOpen: o.leaf ? o.leaf.open !== false : true,
    });
  });

  return out;
}

function sideAddr(iv: Interval, order: Map<string, number>): string {
  const rooms = [...new Set(iv.sides.map((s) => s.room))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const r = rooms[0] ?? "?";
  const side = iv.sides.find((s) => s.room === r);
  return `${r}#${side ? side.edge : "?"}`;
}

function edgeIndexOf(g: OpeningGeo): number {
  const parts = g.edge.split("#");
  return Number(parts[parts.length - 1]);
}

// opening mRange mapped into interval-local coordinate s for overlap tests
function sRange(iv: Interval, _idx: number, _lvl: string, center: V2, mRange: [number, number],
  e: AuthorEdge, _room: string): [number, number] {
  if (!iv.arc) {
    const dx = iv.to[0] - iv.from[0];
    const dz = iv.to[1] - iv.from[1];
    const l = Math.hypot(dx, dz) || 1;
    const sOf = (p: V2): number => ((p[0] - iv.from[0]) * dx + (p[1] - iv.from[1]) * dz) / l;
    const L = e.len || 1;
    const f0 = Math.min(1, Math.max(0, mRange[0] / L));
    const f1 = Math.min(1, Math.max(0, mRange[1] / L));
    const p0 = edgePoint(e, f0).p;
    const p1 = edgePoint(e, f1).p;
    const a = sOf(p0);
    const b = sOf(p1);
    return [Math.min(a, b), Math.max(a, b)];
  }
  const c = iv.arc.c;
  const r = iv.arc.r;
  const sweep = arcSweepOf(iv);
  const Li = Math.abs(r * sweep) || 1;
  const a0 = specAng(iv.from, c);
  const sOf = (p: V2): number => {
    return arcFrac(wrapTau(specAng(p, c) - a0), sweep) * Li;
  };
  const L = e.len || 1;
  const f0 = mRange[0] / L;
  const f1 = mRange[1] / L;
  const p0 = edgePoint(e, closed01(e, f0)).p;
  const p1 = edgePoint(e, closed01(e, f1)).p;
  const a = sOf(p0);
  const b = sOf(p1);
  return [Math.min(a, b), Math.max(a, b)];
}

/** does `r` lie inside the side range `m` of a closed edge of length `L`?
 *  Both may wrap past the seam: a part of a split circle runs [a, b], b ≤ a + L */
function fitsCyclic(m: [number, number], r: [number, number], L: number): boolean {
  if (m[1] - m[0] >= L - 1e-6) return true;
  const lo = ((r[0] % L) + L) % L;
  const hi = lo + (r[1] - r[0]);
  return [0, L, -L].some((k) => m[0] - 1e-6 <= lo + k && hi + k <= m[1] + 1e-6);
}

function closed01(e: AuthorEdge, f: number): number {
  return closed01Edge(e, f);
}

function closed01Edge(e: AuthorEdge, f: number): number {
  const closed = !!e.arc && Math.hypot(e.from[0] - e.to[0], e.from[1] - e.to[1]) < EPS;
  if (!closed) return Math.min(1, Math.max(0, f));
  return wrapTau(f * TAU) / TAU;
}

// split a possibly wrapping [m0, m1] range on a closed circle into 1-2 linear ranges
function splitWrapped(mRange: [number, number], len: number): Array<[number, number]> {
  const L = len || 1;
  let a = ((mRange[0] % L) + L) % L;
  let b = ((mRange[1] % L) + L) % L;
  if (mRange[1] - mRange[0] >= L - 1e-9) return [[0, L]];
  if (a <= b + 1e-12) return [[a, b]];
  return [[a, L], [0, b]];
}

function segsHit(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  for (const x of a) for (const y of b) {
    if (x[0] < y[1] - 1e-9 && y[0] < x[1] - 1e-9) return true;
  }
  return false;
}
