import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import type { RoomGeo } from "../types.js";
import { beamPolys } from "../props/place.js";

/** headroom under which a flight needs the slab above it cut (spec "Лестницы") */
export const HEADROOM = 2.0;

export interface StairGeo {
  id: string;
  i: number;
  /** null when the flight could not be laid out at all (no rooms, Δy ≤ 0) */
  bad: null | { kind: "exit"; at: V2; room: string };
  width: number;
  going: number;
  /** actual rise Δy / N */
  rise: number;
  n: number;
  len: number;
  from: V2;
  dir: V2;
  exit: V2;
  y0: number;
  dy: number;
  /** flight axis interval where the slab under `to.room` is cut away */
  cut: V2[] | null;
  /** flight axis interval with too little headroom and no `to.room` above */
  headroom: { s0: number; s1: number; min: number } | null;
}

/** angles follow the scene convention: 0 = +Z, 90 = +X (spec "Соглашения") */
function dirVec(deg: number): V2 {
  const a = (deg * Math.PI) / 180;
  const s = Math.sin(a);
  const c = Math.cos(a);
  return [Math.abs(s) < EPS ? 0 : s, Math.abs(c) < EPS ? 0 : c];
}

function inside(poly: V2[], p: V2): boolean {
  let hit = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xi, zi] = poly[a];
    const [xj, zj] = poly[b];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** flight-axis parameters where the centreline crosses the outline of `poly` */
function crossings(poly: V2[], p0: V2, d: V2, sLo: number, sHi: number): number[] {
  const out: number[] = [];
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const e0 = poly[b];
    const e1 = poly[a];
    const ex = e1[0] - e0[0];
    const ez = e1[1] - e0[1];
    const den = d[0] * ez - d[1] * ex;
    if (Math.abs(den) < EPS) continue;
    const s = ((e0[0] - p0[0]) * ez - (e0[1] - p0[1]) * ex) / den;
    const t = (d[0] * (e0[1] - p0[1]) - d[1] * (e0[0] - p0[0])) / -den;
    if (t < -EPS || t > 1 + EPS) continue;
    if (s > sLo + EPS && s < sHi - EPS) out.push(s);
  }
  return out.sort((x, y) => x - y);
}

export function placeStairs(ctx: Ctx): StairGeo[] {
  const scene = ctx.scene as any;
  const list: any[] = scene.stairs ?? [];
  const rooms: RoomGeo[] = (ctx.rooms ?? []) as RoomGeo[];
  const byId = new Map<string, RoomGeo>(rooms.map((r) => [r.id as string, r]));
  const levelY = new Map<string, number>();
  for (const l of (scene.levels ?? []) as any[]) {
    if (typeof l?.id === "string" && typeof l?.y === "number") levelY.set(l.id, l.y);
  }

  return list.map((s, i) => {
    const id = String(s?.id);
    const at: V2 = [s?.from?.at?.[0] ?? 0, s?.from?.at?.[1] ?? 0];
    const width = typeof s?.width === "number" ? s.width : 1.0;
    const going = typeof s?.going === "number" ? s.going : 0.28;
    const rise = typeof s?.rise === "number" ? s.rise : 0.17;
    const toRoom = String(s?.to?.room);
    const fromGeo = byId.get(String(s?.from?.room));
    const toGeo = byId.get(toRoom);
    const dir = dirVec(typeof s?.from?.dir === "number" ? s.from.dir : 0);
    const base: StairGeo = {
      id,
      i,
      bad: { kind: "exit", at, room: toRoom },
      width,
      going,
      rise,
      n: 0,
      len: 0,
      from: at,
      dir,
      exit: at,
      y0: 0,
      dy: 0,
      cut: null,
      headroom: null,
    };
    if (!fromGeo || !toGeo) return base;
    const y0 = levelY.get(String(fromGeo.level)) ?? 0;
    const y1 = levelY.get(String(toGeo.level)) ?? 0;
    const dy = y1 - y0;
    // Δy ≤ 0: nothing to climb, so there is no N to divide by (review focus)
    if (dy <= 0) return base;

    const n = Math.max(1, Math.round(dy / rise));
    const r = dy / n;
    const len = (n - 1) * going;
    const exit: V2 = [at[0] + dir[0] * len, at[1] + dir[1] * len];
    const outline = (toGeo.outline ?? []) as V2[];
    // the outline is a tessellated approximation of a circular room; a point
    // near its true boundary can fall outside the polygon but inside the
    // circle it approximates, so check the actual circle when there is one
    const rawTo = ((scene.rooms ?? []) as any[]).find((rr) => rr?.id === toRoom);
    const insideTo = (p: V2): boolean => {
      if (rawTo?.circle && Array.isArray(rawTo.circle.c) && typeof rawTo.circle.r === "number") {
        return Math.hypot(p[0] - rawTo.circle.c[0], p[1] - rawTo.circle.c[1]) <= rawTo.circle.r + EPS;
      }
      return inside(outline, p);
    };
    if (!insideTo(exit)) {
      return { ...base, n, rise: r, len, exit, y0, dy, bad: { kind: "exit", at: exit, room: toRoom } };
    }

    const geo: StairGeo = { ...base, bad: null, n, rise: r, len, exit, y0, dy };

    // the solid above the flight is the ceiling of the room it runs in; under
    // `to.room` that same plane is the bottom of its slab, so it can be cut
    const ceil = Number(fromGeo.height ?? 0);
    const nose = (s0: number): number => r + s0 * (r / going);
    const clear = (s0: number): number => ceil - nose(s0);
    // nose(s) grows with s, so the headroom runs out once and stays out
    const sLo = Math.max(0, ((ceil - HEADROOM - r) * going) / r);
    if (sLo < len - EPS) {
      // the slab can only be cut where the whole tread width is under
      // `to.room`, so the sweep samples three lanes across the flight (both
      // edges, pulled in by 1 mm so a wall flush with the flight edge still
      // counts, and the axis) instead of the centreline alone
      const px: V2 = [-dir[1], dir[0]];
      const hw = width / 2;
      const laneOff = [-Math.max(0, hw - 1e-3), 0, Math.max(0, hw - 1e-3)];
      const lanes: V2[] = laneOff.map((off) => [at[0] + px[0] * off, at[1] + px[1] * off]);
      // a circular `to.room` is tessellated for its outline, so crossing
      // points taken from that polygon can miss the true boundary; solve
      // the line/circle intersection directly when there is a circle
      const circleCrossings = (p0: V2): number[] => {
        if (!rawTo?.circle || !Array.isArray(rawTo.circle.c) || typeof rawTo.circle.r !== "number") return [];
        const [cx, cz] = rawTo.circle.c as [number, number];
        const r0 = rawTo.circle.r as number;
        const ox = p0[0] - cx;
        const oz = p0[1] - cz;
        const b = 2 * (dir[0] * ox + dir[1] * oz);
        const c = ox * ox + oz * oz - r0 * r0;
        const disc = b * b - 4 * c;
        if (disc < 0) return [];
        const sq = Math.sqrt(disc);
        return [(-b - sq) / 2, (-b + sq) / 2].filter((s) => s > sLo + EPS && s < len - EPS);
      };
      const breaks = [
        sLo,
        ...lanes.flatMap((p0) => [...circleCrossings(p0), ...crossings(outline, p0, dir, sLo, len)]),
        len,
      ].sort((x, y) => x - y);
      const cover: Array<{ a: number; b: number; under: boolean }> = [];
      for (let k = 0; k + 1 < breaks.length; k++) {
        const a = breaks[k];
        const b = breaks[k + 1];
        if (b - a < EPS) continue;
        const mid = (a + b) / 2;
        cover.push({ a, b, under: lanes.every((p0) => insideTo([p0[0] + dir[0] * mid, p0[1] + dir[1] * mid])) });
      }
      // the exit (s = len) is under `to.room` (checked above), so walk back
      // from it and stop at the first gap: disjoint under-spans (e.g. a notch
      // in `to.room`'s footprint) must not be bridged into one cut
      let cutK = cover.length;
      while (cutK > 0 && cover[cutK - 1].under) cutK--;
      if (cutK < cover.length) {
        const a = cover[cutK].a;
        const b = cover[cover.length - 1].b;
        const corner = (sv: number, side: number): V2 => [
          at[0] + dir[0] * sv + px[0] * hw * side,
          at[1] + dir[1] * sv + px[1] * hw * side,
        ];
        geo.cut = [corner(a, 1), corner(b, 1), corner(b, -1), corner(a, -1)];
      }
      // everything short of the cut keeps the ceiling / slab bottom overhead:
      // spans not under `to.room`, and also under-spans stranded behind a gap
      // (their slab is left whole, so the headroom there is just as short)
      const open = cover.slice(0, cutK);
      if (open.length > 0) {
        const s0 = Math.min(...open.map((c) => c.a));
        const s1 = Math.max(...open.map((c) => c.b));
        geo.headroom = { s0, s1, min: clear(s1) };
      }
    }

    // a beam hanging from a room's own ceiling can locally eat into headroom
    // anywhere along the flight, independent of the slab-cut threshold above
    // (review focus: overhead solids other than the ceiling). Both the room
    // the flight runs through (its own ceiling, at `ceil` above y0) and the
    // room it climbs into (a beam there can hang low enough to poke through
    // that room's own floor, into the stairwell below) must be checked.
    const rawFrom = ((scene.rooms ?? []) as any[]).find((rr) => rr?.id === String(s?.from?.room));
    const beamSources: Array<{ beams: ReturnType<typeof beamPolys>; roomCeil: number }> = [
      { beams: beamPolys(rawFrom), roomCeil: ceil },
      { beams: beamPolys(rawTo), roomCeil: dy + Number(toGeo.height ?? 0) },
    ];
    const allBeams = beamSources.flatMap((src) => src.beams.map((bm) => ({ ...bm, roomCeil: src.roomCeil })));
    if (allBeams.length > 0) {
      // the flight is `width` wide, so a beam can hang over one half of it and
      // miss the centreline entirely; sample across the tread, not just along
      // its axis (spec "Лестницы": просвет над маршем)
      const px0: V2 = [-dir[1], dir[0]];
      const lanes: V2[] = [-width / 2, 0, width / 2].map((off) => [
        at[0] + px0[0] * off,
        at[1] + px0[1] * off,
      ]);
      const bBreaks = [
        0,
        ...lanes.flatMap((p0) => allBeams.flatMap((bm) => crossings(bm.poly, p0, dir, 0, len))),
        ...crossings(outline, at, dir, 0, len),
        len,
      ];
      const uniq = [...new Set(bBreaks)].sort((x, y) => x - y);
      let bS0: number | undefined;
      let bS1: number | undefined;
      let bMin: number | undefined;
      for (let k = 0; k + 1 < uniq.length; k++) {
        const a = uniq[k];
        const b = uniq[k + 1];
        if (b - a < EPS) continue;
        const mids: V2[] = lanes.map((p0) => [
          p0[0] + dir[0] * ((a + b) / 2),
          p0[1] + dir[1] * ((a + b) / 2),
        ]);
        let minClearHere: number | undefined;
        for (const bm of allBeams) {
          if (!mids.some((m) => inside(bm.poly, m))) continue;
          const clearHere = bm.roomCeil - bm.h - nose(b);
          minClearHere = minClearHere === undefined ? clearHere : Math.min(minClearHere, clearHere);
        }
        if (minClearHere === undefined || minClearHere >= HEADROOM - EPS) continue;
        bS0 = bS0 === undefined ? a : Math.min(bS0, a);
        bS1 = bS1 === undefined ? b : Math.max(bS1, b);
        bMin = bMin === undefined ? minClearHere : Math.min(bMin, minClearHere);
      }
      if (bMin !== undefined) {
        geo.headroom = geo.headroom
          ? { s0: Math.min(geo.headroom.s0, bS0!), s1: Math.max(geo.headroom.s1, bS1!), min: Math.min(geo.headroom.min, bMin) }
          : { s0: bS0!, s1: bS1!, min: bMin };
      }
    }
    return geo;
  });
}
