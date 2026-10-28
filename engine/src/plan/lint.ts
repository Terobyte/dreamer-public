import type { Ctx } from "../ctx.js";
import type { Issue } from "../types.js";
import { compileRooms } from "./rooms.js";
import { mergeLevel } from "./merge.js";
import type { Side } from "./merge.js";
import { driftIssues } from "./drift.js";

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
  const lvlIds = [...new Set(rooms.map((r) => r.level))];
  for (const lvl of lvlIds) {
    const plan = mergeLevel(roomsForMerge as never, lvl);
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
        // arc edge: for shared-wall test, sides cover [0, len]
        for (const iv of mine) {
          if (!iv.arc) continue;
          const side = iv.sides.find((s: Side) => s.room === r.id && s.edge === e.i)!;
          const neigh = iv.sides.find((s: Side) => !(s.room === r.id && s.edge === e.i));
          if (!neigh) continue;
          segs.push({ t0: 0, t1: e.len, neigh });
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
        arc: e.arc,
        normal_in: e.normalIn,
        sides: merged.map((m) => ({ room: m.room, m: [m.t0, m.t1] })),
      });
    });
  }
  ctx.passport.edges = outEdges;
  const drift = driftIssues(rooms, rawRooms);
  return [...issues, ...drift];
}
