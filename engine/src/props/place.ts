import type { Ctx } from "../ctx.js";
import type { PropGeo } from "../types.js";
import type { V2 } from "../geom/vec.js";
import { EPS, degFromVec } from "../geom/vec.js";
import type { OBB } from "../geom/obb.js";
import { obbAabb, obbCorners, obbPolyIntersects } from "../geom/obb.js";

const TAU = Math.PI * 2;
const WALL_GAP = 0.02;
const DEFAULT_THICKNESS = 0.12;
/** `mount: wall` needs an edge of its own room strictly closer than this to `at` */
const WALL_SEARCH = 1.0;

export interface AuthorEdge {
  id: string;
  room: string;
  i: number;
  from: V2;
  to: V2;
  arc: { c: V2; r: number; sweep?: number } | null;
  len: number;
  normalIn: V2;
}

export interface RoomRec {
  id: string;
  level: string;
  height: number;
  edges: AuthorEdge[];
}

export function specAng(p: V2, c: V2): number {
  return Math.atan2(p[0] - c[0], p[1] - c[1]);
}

function wrapTau(x: number): number {
  return ((x % TAU) + TAU) % TAU;
}

export function isClosed(e: AuthorEdge): boolean {
  return !!e.arc && Math.hypot(e.from[0] - e.to[0], e.from[1] - e.to[1]) < EPS;
}

export function edgePoint(e: AuthorEdge, frac: number): V2 {
  if (!e.arc) {
    return [e.from[0] + (e.to[0] - e.from[0]) * frac, e.from[1] + (e.to[1] - e.from[1]) * frac];
  }
  const { c, r } = e.arc;
  const a0 = isClosed(e) ? 0 : specAng(e.from, c);
  const sweep = isClosed(e) ? TAU : e.arc.sweep ?? 0;
  const ang = a0 + sweep * frac;
  return [c[0] + r * Math.sin(ang), c[1] + r * Math.cos(ang)];
}

/** inward normal of the edge at a point on its axis (radial on arcs) */
export function edgeNormal(e: AuthorEdge, p: V2): V2 {
  if (!e.arc) return [e.normalIn[0], e.normalIn[1]];
  const c = e.arc.c;
  if (isClosed(e)) {
    const d: V2 = [c[0] - p[0], c[1] - p[1]];
    const l = Math.hypot(d[0], d[1]) || 1;
    return [d[0] / l, d[1] / l];
  }
  let n: V2 = [p[0] - c[0], p[1] - c[1]];
  const l = Math.hypot(n[0], n[1]) || 1;
  n = [n[0] / l, n[1] / l];
  if (n[0] * e.normalIn[0] + n[1] * e.normalIn[1] < 0) n = [-n[0], -n[1]];
  return n;
}

export function closestOnEdge(p: V2, e: AuthorEdge): { d: number; q: V2 } {
  if (!e.arc) {
    const dx = e.to[0] - e.from[0];
    const dz = e.to[1] - e.from[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((p[0] - e.from[0]) * dx + (p[1] - e.from[1]) * dz) / l2 : 0;
    t = Math.min(1, Math.max(0, t));
    const q: V2 = [e.from[0] + dx * t, e.from[1] + dz * t];
    return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q };
  }
  const { c, r } = e.arc;
  const ang = specAng(p, c);
  let angAt = ang;
  if (!isClosed(e)) {
    const a0 = specAng(e.from, c);
    const sweep = e.arc.sweep ?? 0;
    const rel = wrapTau(ang - a0);
    // rel == 0 and rel == TAU are the same angle (the arc start); the
    // raw formula maps 0 to the far end for negative sweeps
    const f = sweep >= 0 ? rel / sweep : rel < EPS ? 0 : (rel - TAU) / sweep;
    angAt = a0 + sweep * Math.min(1, Math.max(0, f));
  }
  const q: V2 = [c[0] + r * Math.sin(angAt), c[1] + r * Math.cos(angAt)];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q };
}

export function fracOf(e: AuthorEdge, on: any): number {
  const L = e.len || 1;
  if (typeof on?.t === "number") return on.t;
  if (typeof on?.m === "number") return isClosed(e) ? (((on.m % L) + L) % L) / L : on.m / L;
  if (typeof on?.az === "number") {
    const rad = (on.az * Math.PI) / 180;
    if (isClosed(e)) return wrapTau(rad) / TAU;
    const sweep = e.arc?.sweep ?? 0;
    if (Math.abs(sweep) < EPS) return 0;
    const rel = wrapTau(rad - specAng(e.from, e.arc!.c));
    const f = sweep >= 0 ? rel / sweep : rel < EPS ? 0 : (rel - TAU) / sweep;
    return Math.min(1, Math.max(0, f));
  }
  return 0;
}

/** beam footprints of a room, as plan polygons */
export function beamPolys(raw: any): Array<{ poly: V2[]; h: number }> {
  const out: Array<{ poly: V2[]; h: number }> = [];
  for (const b of (raw?.beams ?? []) as any[]) {
    const a: V2 = [b.from[0], b.from[1]];
    const c: V2 = [b.to[0], b.to[1]];
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const l = Math.hypot(dx, dz);
    if (l < EPS) continue;
    const w = typeof b.w === "number" ? b.w : 0.2;
    const h = typeof b.h === "number" ? b.h : 0.25;
    const px: V2 = [(-dz / l) * (w / 2), (dx / l) * (w / 2)];
    out.push({
      poly: [
        [a[0] + px[0], a[1] + px[1]],
        [c[0] + px[0], c[1] + px[1]],
        [c[0] - px[0], c[1] - px[1]],
        [a[0] - px[0], a[1] - px[1]],
      ],
      h,
    });
  }
  return out;
}

/** nearest edge of the room; `toFace` measures to the inner face, not the axis */
export function nearestEdge(p: V2, room: RoomRec, thickness: number, toFace: boolean):
  { e: AuthorEdge; q: V2; n: V2; d: number } | null {
  let best: { e: AuthorEdge; q: V2; n: V2; d: number } | null = null;
  for (const e of room.edges) {
    const { q } = closestOnEdge(p, e);
    const n = edgeNormal(e, q);
    const ref: V2 = toFace ? [q[0] + n[0] * (thickness / 2), q[1] + n[1] * (thickness / 2)] : q;
    const d = Math.hypot(p[0] - ref[0], p[1] - ref[1]);
    if (!best || d < best.d - 1e-12) best = { e, q, n, d };
  }
  return best;
}

export function placeProps(ctx: Ctx): PropGeo[] {
  const scene = ctx.scene as any;
  const rooms: RoomRec[] = (ctx.rooms ?? []) as RoomRec[];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const rawById = new Map<string, any>(((scene.rooms ?? []) as any[]).map((r) => [String(r.id), r]));
  const openings = (ctx.openings ?? []) as any[];

  const out: PropGeo[] = [];
  const byId = new Map<string, PropGeo>();
  const list: any[] = scene.props ?? [];
  const pending = list.map((_, i) => i);

  const thicknessOf = (roomId: string): number => {
    const t = rawById.get(roomId)?.walls?.thickness;
    return typeof t === "number" ? t : DEFAULT_THICKNESS;
  };

  /** a shared wall is as thick as its thickest side: read the merged interval
   *  under the mount point, fall back to the room's own thickness */
  const wallThicknessAt = (room: RoomRec, e: AuthorEdge, q: V2): number => {
    const plan = ctx.levels?.get(room.level);
    const m = e.arc ? null : Math.hypot(q[0] - e.from[0], q[1] - e.from[1]);
    let best = -1;
    for (const iv of plan?.intervals ?? []) {
      for (const s of iv.sides) {
        if (s.room !== e.room || s.edge !== e.i) continue;
        if (m !== null && (m < s.m[0] - EPS || m > s.m[1] + EPS)) continue;
        best = Math.max(best, iv.thickness);
      }
    }
    return best > 0 ? best : thicknessOf(room.id);
  };

  const levelYOf = (room: RoomRec): number => {
    const lvl = (scene.levels ?? []).find((l: any) => String(l?.id) === room.level);
    return typeof lvl?.y === "number" ? lvl.y : 0;
  };

  const targetOf = (name: string): V2 | null => {
    const p = byId.get(name);
    if (p) return [p.obb.c[0], p.obb.c[1]];
    const o = openings.find((g) => g.id === name && !g.error);
    if (o && o.center) return [o.center[0], o.center[1]];
    return null;
  };

  /** names that may resolve to a position once later props are placed */
  const propIds = new Set(list.map((p: any) => String(p?.id)));
  const openingIds = new Set(openings.filter((g: any) => g && !g.error).map((g: any) => String(g.id)));
  const isValidTarget = (name: string): boolean =>
    propIds.has(String(name)) || openingIds.has(String(name));

  // `around.center` / `top_of` may name a prop declared later: keep retrying
  // until a pass places nothing new, then drop whatever never resolved
  for (let guard = 0; guard <= list.length && pending.length > 0; guard++) {
    const stuck: number[] = [];
    let placed = 0;
    for (const i of pending) {
      const made = placeOne(list[i], i);
      if (made === null) stuck.push(i);
      else placed += made;
    }
    pending.length = 0;
    pending.push(...stuck);
    if (placed === 0) break;
  }

  // stable sort: source scene order (around copies keep k order)
  const ordered = [...out].sort((a, b) => a.src - b.src);
  ctx.passport.props = ordered.map((p) => {
    const [lo, hi] = obbAabb(p.obb);
    return {
      id: p.id,
      yaw: p.obb.yaw,
      obb: obbCorners(p.obb),
      y: p.y,
      aabb: [lo, hi],
      wall: p.wall,
      size: p.size,
    };
  });
  return out;

  /** null = dependency not placed yet; otherwise the number of entries added */
  function placeOne(raw: any, idx: number): number | null {
    const room = roomById.get(String(raw.room));
    if (!room) return 0;
    const rawRoom = rawById.get(String(raw.room));
    const size = { w: raw.size.w, d: raw.size.d, h: raw.size.h };
    const half: [number, number] = [size.w / 2, size.d / 2];
    const solid = raw.solid !== false;
    const mount = raw.mount ?? "floor";
    const beams = beamPolys(rawRoom);
    const thickness = thicknessOf(room.id);

    const finish = (id: string, copy: number | undefined, c: V2, yaw: number,
      y: [number, number], wall: string | null): void => {
      const geo: PropGeo = {
        id,
        src: idx,
        ...(copy === undefined ? {} : { copy }),
        room: room.id,
        obb: { c, half, yaw } as OBB,
        y,
        wall,
        solid,
        size,
      };
      out.push(geo);
      byId.set(id, geo);
    };

    /** vertical span of a floor-standing / hanging prop at footprint `c` */
    const spanFor = (c: V2, yaw: number): [number, number] | null => {
      const base = levelYOf(room);
      if (mount === "ceiling") {
        let top = base + room.height;
        const obb: OBB = { c, half, yaw };
        for (const b of beams) {
          if (obbPolyIntersects(obb, [b.poly])) top = Math.min(top, base + room.height - b.h);
        }
        return [top - size.h, top];
      }
      return [base, base + size.h];
    };

    /** "later" = a valid reference whose target is not placed yet; "fatal" = never resolvable */
    const faceTargetState = (): "ok" | "later" | "fatal" => {
      if (typeof raw.yaw === "number") return "ok";
      const face = raw.face;
      if (face === "room") return "ok";
      if (typeof face === "string" && face !== "room") {
        if (targetOf(face)) return "ok";
        if (isValidTarget(face)) return "later";
        return "fatal";
      }
      if (Array.isArray(face)) return "ok";
      if (mount === "ceiling") return "ok";
      return "fatal";
    };

    const yawFromFace = (at: V2): number | null => {
      if (typeof raw.yaw === "number") return raw.yaw;
      const face = raw.face;
      if (face === "room") {
        const near = nearestEdge(at, room, thickness, true);
        if (!near) return null;
        return degFromVec(near.n[0], near.n[1]);
      }
      if (typeof face === "string" && face !== "room") {
        const t = targetOf(face);
        if (!t) return null;
        return degFromVec(t[0] - at[0], t[1] - at[1]);
      }
      if (Array.isArray(face)) {
        return degFromVec(face[0] - at[0], face[1] - at[1]);
      }
      if (mount === "ceiling") return 0;
      return null;
    };

    if (raw.around) {
      const center = targetOf(String(raw.around.center));
      if (!center) return null;
      // `around` copies keep their own mount: on top_of they sit on the support,
      // not on the floor (the ring only gives the footprint)
      let topOfBase: number | null = null;
      if (mount && typeof mount === "object" && mount.top_of) {
        const support = byId.get(String(mount.top_of));
        if (!support) {
          if (propIds.has(String(mount.top_of))) return null;
          return 0;
        }
        topOfBase = support.y[1];
      }
      const n = raw.around.n as number;
      const r = raw.around.r as number;
      const start = typeof raw.around.start === "number" ? raw.around.start : 0;
      for (let k = 0; k < n; k++) {
        const th = start + (k * 360) / n;
        const rad = (th * Math.PI) / 180;
        const c: V2 = [center[0] + r * Math.sin(rad), center[1] + r * Math.cos(rad)];
        const yaw = ((th + 180) % 360 + 360) % 360;
        const y: [number, number] | null =
          topOfBase === null ? spanFor(c, yaw) : [topOfBase, topOfBase + size.h];
        if (!y) continue;
        finish(`${raw.id}.${k}`, k, c, yaw, y, null);
      }
      return n;
    }

    if (mount === "wall") {
      let hit: { e: AuthorEdge; q: V2; n: V2 } | null = null;
      if (raw.on && typeof raw.on === "object") {
        const e = room.edges.find((x) => x.i === raw.on.edge);
        if (!e) return 0;
        const q = edgePoint(e, fracOf(e, raw.on));
        hit = { e, q, n: edgeNormal(e, q) };
      } else {
        const near = nearestEdge([raw.at[0], raw.at[1]], room, thickness, false);
        if (!near || near.d >= WALL_SEARCH - EPS) return 0;
        hit = { e: near.e, q: near.q, n: near.n };
      }
      const { e, q, n } = hit;
      const wallT = wallThicknessAt(room, e, q);
      const y0 = levelYOf(room) + (typeof raw.y === "number" ? raw.y : 1.0);
      const yaw = degFromVec(n[0], n[1]);
      if (!e.arc) {
        // back face centre sits on the inner face + gap, then + d/2
        const off = wallT / 2 + WALL_GAP + half[1];
        const c: V2 = [q[0] + n[0] * off, q[1] + n[1] * off];
        finish(String(raw.id), undefined, c, yaw, [y0, y0 + size.h], e.id);
        return 1;
      }
      // arc: back edge on the inner-face chord (spec "Модель стены"), so it
      // never crosses the wall. concave face (centre on the room side):
      // chord ends on the face + 0.02; convex face (b < 0): chord midpoint
      // on the face + 0.02, ends stick further into the room.
      const Cc = e.arc.c;
      const axisAng = specAng(q, Cc);
      const rr: V2 = [q[0] - Cc[0], q[1] - Cc[1]];
      const rl = Math.hypot(rr[0], rr[1]) || 1;
      const convex = (n[0] * rr[0] + n[1] * rr[1]) / rl > 0;
      // inner-face radius: axis point pushed t/2 along the inward normal
      const faceR = Math.hypot(
        q[0] + n[0] * (wallT / 2) - Cc[0],
        q[1] + n[1] * (wallT / 2) - Cc[1],
      );
      const dir = (a: number): V2 => [Math.sin(a), Math.cos(a)];
      let mid: V2;
      if (convex) {
        const d = dir(axisAng);
        const mR = faceR + WALL_GAP;
        mid = [Cc[0] + mR * d[0], Cc[1] + mR * d[1]];
      } else {
        const eR = faceR - WALL_GAP;
        const halfAng = Math.asin(Math.min(1, half[0] / eR));
        const da = dir(axisAng - halfAng);
        const db = dir(axisAng + halfAng);
        const A: V2 = [Cc[0] + eR * da[0], Cc[1] + eR * da[1]];
        const B: V2 = [Cc[0] + eR * db[0], Cc[1] + eR * db[1]];
        mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      }
      const c: V2 = [mid[0] + n[0] * half[1], mid[1] + n[1] * half[1]];
      finish(String(raw.id), undefined, c, yaw, [y0, y0 + size.h], e.id);
      return 1;
    }

    if (mount && typeof mount === "object" && mount.top_of) {
      const support = byId.get(String(mount.top_of));
      if (!support) {
        if (typeof mount.top_of === "string" && propIds.has(String(mount.top_of))) return null;
        return 0;
      }
      const at: V2 = Array.isArray(raw.at)
        ? [raw.at[0], raw.at[1]]
        : [support.obb.c[0], support.obb.c[1]];
      if (faceTargetState() === "later") return null;
      const yaw = yawFromFace(at);
      if (yaw === null) return 0;
      const y0 = support.y[1];
      finish(String(raw.id), undefined, at, yaw, [y0, y0 + size.h], null);
      return 1;
    }

    const at: V2 = [raw.at[0], raw.at[1]];
    if (faceTargetState() === "later") return null;
    const yaw = yawFromFace(at);
    if (yaw === null) return 0;
    const y = spanFor(at, yaw);
    if (!y) return 0;
    finish(String(raw.id), undefined, at, yaw, y, null);
    return 1;
  }
}
