import type { Ctx } from "../ctx.js";
import type { NavJson, PropGeo } from "../types.js";
import type { V2 } from "../geom/vec.js";
import { obbCorners } from "../geom/obb.js";
import { closestOnEdge } from "../props/place.js";
import { freeWalls, freeWallPoly } from "../plan/merge.js";
import { fixtureGeos, fixtureFootprint } from "../build/fixtures.js";
import { pointInPoly, CELL, type NavRamp } from "../nav/floor.js";
import type { OpeningGeo } from "../openings/resolve.js";
import { cellCenter, cellOf, gridOf, walkable, SNAP_R } from "./astar.js";

/** A prop is reached from a walkable cell no farther than this from its OBB (spec "Маршруты"). */
export const PROP_R = 0.6;

export interface Waypoint {
  at: V2;
  /** which nav layer the point lives on: a route may change levels by a flight */
  level: string;
  /** how the target reads in `ROUTE_BLOCKED`: `{route}: ... по пути к {цель}` */
  label: string;
  /** snap radius for "is this point reachable at all" (spec "Маршруты"): 0.6 m for a prop, 0.3 m otherwise. */
  radius: number;
}

export type WaypointResult = { ok: true; wp: Waypoint } | { ok: false; kind: string; v: string; have: string };

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Distance from p to a simple polygon (0 inside). */
export function distToPoly(p: V2, poly: V2[]): number {
  if (pointInPoly(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
    t = Math.min(1, Math.max(0, t));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t)));
  }
  return best;
}

/** The walkable cell nearest to a prop's footprint, within `PROP_R` of it. */
function propApproach(nav: NavJson, level: string, g: PropGeo): V2 | null {
  const grid = gridOf(nav, level);
  if (!grid) return null;
  const poly = obbCorners(g.obb);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const pad = PROP_R + CELL;
  const [i0, j0] = cellOf(grid, [minX - pad, minZ - pad]);
  const [i1, j1] = cellOf(grid, [maxX + pad, maxZ + pad]);
  let best: V2 | null = null;
  let bestD = Infinity;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!walkable(grid, i, j)) continue;
      const c = cellCenter(grid, i, j);
      const d = distToPoly(c, poly);
      if (d > PROP_R + 1e-9 || d >= bestD) continue;
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * One authored route point as a plan position. A string that names no
 * opening or prop, or an object naming no room, is a bad reference: it must
 * be reported as `REF_UNKNOWN`, not silently skipped.
 */
export function waypoint(ctx: Ctx, nav: NavJson, level: string, point: unknown): WaypointResult {
  const rooms = (ctx.rooms ?? []) as any[];
  const levelOf = (room: string): string => rooms.find((r) => r.id === room)?.level ?? level;
  if (point === "spawn") {
    const at = (ctx.scene as any).spawn?.at;
    return { ok: true, wp: { at: [Number(at[0]), Number(at[1])], level, label: "spawn", radius: SNAP_R } };
  }
  if (typeof point === "string") {
    const op = ((ctx.openings ?? []) as OpeningGeo[]).find((g) => g.id === point && !g.error);
    if (op) {
      const at: V2 = [op.center[0], op.center[1]];
      return { ok: true, wp: { at, level: op.intervalLevel || level, label: op.id, radius: SNAP_R } };
    }
    // a flight is reached at its foot, on the level it rises from
    const ramp = ((nav.ramps ?? []) as NavRamp[]).find((r) => r.stair === point);
    const link = ((nav.links ?? []) as any[]).find((l) => String(l?.via) === point);
    if (ramp && link) {
      const at: V2 = [ramp.axis.from[0], ramp.axis.from[1]];
      return { ok: true, wp: { at, level: String(link.from), label: point, radius: SNAP_R } };
    }
    const prop = ((ctx.props ?? []) as PropGeo[]).find((g) => g.id === point);
    if (prop) {
      const pl = levelOf(prop.room);
      const at = propApproach(nav, pl, prop) ?? [prop.obb.c[0], prop.obb.c[1]];
      return { ok: true, wp: { at: [at[0], at[1]], level: pl, label: prop.id, radius: PROP_R } };
    }
    const have = [
      ...((ctx.openings ?? []) as OpeningGeo[]).filter((g) => !g.error).map((g) => g.id),
      ...((ctx.props ?? []) as PropGeo[]).map((g) => g.id),
      ...((nav.ramps ?? []) as NavRamp[]).map((r) => r.stair),
    ].join(", ");
    return { ok: false, kind: "точка маршрута", v: point, have };
  }
  if (point !== null && typeof point === "object") {
    const o = point as Record<string, unknown>;
    const room = String(o.room);
    if (!rooms.some((r) => r.id === room)) {
      return { ok: false, kind: "комната", v: room, have: rooms.map((r) => r.id).join(", ") };
    }
    const at = o.at as unknown;
    const x = Number(Array.isArray(at) ? at[0] : NaN);
    const z = Number(Array.isArray(at) ? at[1] : NaN);
    return {
      ok: true,
      wp: { at: [x, z], level: levelOf(room), label: `${room} (${round2(x)}, ${round2(z)})`, radius: SNAP_R },
    };
  }
  return { ok: false, kind: "точка маршрута", v: String(point), have: "" };
}

/** Shortest distance between two segments in plan (0 when they meet or touch). */
function segSegDist(a: V2, b: V2, c: V2, d: V2): number {
  const cross = (p: V2, q: V2, r: V2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) return 0;
  const toSeg = (p: V2, q: V2, r: V2): number => {
    const dx = r[0] - q[0];
    const dz = r[1] - q[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((p[0] - q[0]) * dx + (p[1] - q[1]) * dz) / l2 : 0;
    t = Math.min(1, Math.max(0, t));
    return Math.hypot(p[0] - (q[0] + dx * t), p[1] - (q[1] + dz * t));
  };
  return Math.min(toSeg(a, c, d), toSeg(b, c, d), toSeg(c, a, b), toSeg(d, a, b));
}

/**
 * What stops the capsule between the cell it got stuck in and the target.
 * A closed leaf on the way wins over geometry: "мешает стена living#0" would
 * send the author looking at the wrong thing when the door is simply shut.
 */
export function blockerBetween(ctx: Ctx, level: string, stuck: V2, target: V2): string {
  const closed = ((ctx.openings ?? []) as OpeningGeo[]).filter(
    (g) => !g.error && g.intervalLevel === level && g.leafOpen === false,
  );
  for (const g of closed) {
    if (segSegDist(stuck, target, g.ends[0], g.ends[1]) <= 1e-6) return `закрытая дверь ${g.id}`;
  }

  let bestId = "вне комнат";
  let bestD = Infinity;
  const take = (id: string, d: number): void => {
    if (d < bestD - 1e-9) {
      bestD = d;
      bestId = id;
    }
  };

  const rooms = ((ctx.rooms ?? []) as any[]).filter((r) => r.level === level);
  for (const r of rooms) {
    for (const e of r.edges) take(e.id, closestOnEdge(stuck, e as never).d);
  }
  for (const w of freeWalls(ctx.scene as never, rooms as never)) {
    if (w.level !== level) continue;
    take(w.id, distToPoly(stuck, freeWallPoly(w)));
  }
  for (const g of (ctx.props ?? []) as PropGeo[]) {
    if (!g.solid) continue;
    if (!rooms.some((r) => r.id === g.room)) continue;
    take(g.id, distToPoly(stuck, obbCorners(g.obb)));
  }
  for (const f of fixtureGeos(ctx)) {
    if (f.level !== level) continue;
    take(`fixture.${f.i}`, distToPoly(stuck, fixtureFootprint(f)));
  }
  return bestId;
}
