import type { Ctx } from "../ctx.js";
import type { Issue } from "../types.js";
import { compileRooms } from "./rooms.js";
import { freeWalls, mergeLevel } from "./merge.js";
import type { Side } from "./merge.js";
import { driftIssues } from "./drift.js";
import { msg } from "../report/messages.js";

export function planStage(ctx: Ctx): Issue[] {
  const { rooms, issues } = compileRooms(ctx.scene);
  ctx.rooms = rooms as never;
  if (issues.length > 0) {
    ctx.passport.edges = [];
    return issues;
  }
  const rawRooms: any[] = (ctx.scene as any).rooms ?? [];
  const thicknessOf = (id: string): number => {
    const r = rawRooms.find((x: any) => x.id === id);
    const t = r?.walls?.thickness;
    return typeof t === "number" && t > 0 ? t : 0.12;
  };
  // merge per level
  const roomsForMerge = rooms.map((r) => ({ ...r, thickness: thicknessOf(r.id) }));
  const levels = new Map<string, ReturnType<typeof mergeLevel>>();
  const free = freeWalls(ctx.scene as never, rooms as never);
  // a free wall can be the only thing on its level (F4): take levels from
  // both rooms and walls, or that level gets no plan and no geometry
  const lvlIds = [...new Set([...rooms.map((r) => r.level), ...free.map((w) => w.level)])];
  // a roomless level has no room heights to take a max of (F8): `h: null`
  // there must not silently fall back to 0 and make the wall vanish
  const rawWalls: any[] = (ctx.scene as any).walls ?? [];
  const hRequired: Issue[] = [];
  free.forEach((w, i) => {
    const onLevel = rooms.some((r) => r.level === w.level);
    if (!onLevel && typeof rawWalls[i]?.h !== "number") {
      const path = `/walls/${i}/h`;
      hRequired.push({ code: "SCHEMA_REQUIRED", stage: "plan", path, msg: msg("SCHEMA_REQUIRED", { path }) });
    }
  });
  for (const lvl of lvlIds) {
    const plan = mergeLevel(roomsForMerge as never, lvl, free);
    levels.set(lvl, plan);
  }
  (ctx as any).levels = levels;

  // passport edges with sides, snaps
  const allSnaps = [...(levels.values() as IterableIterator<ReturnType<typeof mergeLevel>>)].flatMap((p) => p.snaps);
  ctx.passport.snaps = allSnaps.map((s) => ({ from: s.from, to: s.to }));
  const outEdges: unknown[] = [];
  for (const r of rooms) {
    const plan = levels.get(r.level)!;
    const ivs = plan.intervals;
    r.edges.forEach((e) => {
      // find intervals authored by this edge: side matches room+edge
      const mine = ivs.filter((iv) => iv.sides.some((s: Side) => s.room === r.id && s.edge === e.i));
      // build per-edge param intervals [t0,t1] mapped to m of this edge
      type Seg = { t0: number; t1: number; neigh: Side };
      const segs: Seg[] = [];
      if (!e.arc) {
        const L = Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1]);
        const ux = L > 0 ? (e.to[0] - e.from[0]) / L : 1;
        const uz = L > 0 ? (e.to[1] - e.from[1]) / L : 0;
        for (const iv of mine) {
          // project interval midpoint endpoints onto this edge axis
          const proj = (p: [number, number]): number => (p[0] - e.from[0]) * ux + (p[1] - e.from[1]) * uz;
          const a = proj([iv.from[0], iv.from[1]]);
          const b = proj([iv.to[0], iv.to[1]]);
          const lo = Math.max(0, Math.min(a, b));
          const hi = Math.min(L, Math.max(a, b));
          if (hi - lo <= 1e-9) continue;
          const side = iv.sides.find((s: Side) => s.room === r.id && s.edge === e.i)!;
          // neighbor = other side of same interval
          const neigh = iv.sides.find((s: Side) => !(s.room === r.id && s.edge === e.i));
          if (!neigh) continue;
          segs.push({ t0: lo, t1: hi, neigh });
        }
      } else {
        // arc edge: the interval side carries its own m range
        for (const iv of mine) {
          if (!iv.arc) continue;
          const side = iv.sides.find((s: Side) => s.room === r.id && s.edge === e.i)!;
          const neigh = iv.sides.find((s: Side) => !(s.room === r.id && s.edge === e.i));
          if (!neigh) continue;
          segs.push({ t0: side.m[0], t1: side.m[1], neigh });
        }
      }
      segs.sort((a, b) => a.t0 - b.t0);
      // merge adjacent with same neighbor room
      const merged: { t0: number; t1: number; room: string }[] = [];
      for (const s of segs) {
        const last = merged[merged.length - 1];
        if (last && last.room === s.neigh.room && Math.abs(s.t0 - last.t1) <= 1e-6) {
          last.t1 = Math.max(last.t1, s.t1);
        } else {
          merged.push({ t0: s.t0, t1: s.t1, room: s.neigh.room });
        }
      }
      outEdges.push({
        id: e.id,
        from: e.from,
        to: e.to,
        len: e.len,
        // the report's arc is {c, r}; the sweep stays internal
        arc: e.arc ? { c: e.arc.c, r: e.arc.r } : null,
        normal_in: e.normalIn,
        // a part of a split circle may run past the seam: report it in [0, len]
        sides: merged
          .flatMap((m) => (m.t1 > e.len + 1e-6
            ? [{ room: m.room, m: [m.t0, e.len] }, { room: m.room, m: [0, m.t1 - e.len] }]
            : [{ room: m.room, m: [m.t0, m.t1] }]))
          .sort((x, y) => x.m[0] - y.m[0]),
      });
    });
  }
  ctx.passport.edges = outEdges;
  const drift = driftIssues(rooms, rawRooms);
  return [...issues, ...drift, ...hRequired];
}
