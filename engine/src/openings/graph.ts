import type { Ctx } from "../ctx.js";
import type { OpeningGeo } from "./resolve.js";

export function roomGraph(ctx: Ctx): Map<string, string[]> {
  const openings = (ctx.openings ?? []) as OpeningGeo[];
  const g = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!g.has(a)) g.set(a, new Set());
    if (!g.has(b)) g.set(b, new Set());
    g.get(a)!.add(b);
    g.get(b)!.add(a);
  };
  for (const o of openings) {
    if (o.error) continue;
    const rooms = o.rooms;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) link(rooms[i], rooms[j]);
    }
    for (const r of rooms) if (!g.has(r)) g.set(r, new Set());
  }
  // two open places (yards, a street) sharing an edge: no wall stands there, the way is free (docs/street.md)
  const open = new Set(((ctx.scene as any).rooms ?? []).filter((r: any) => r?.open === true).map((r: any) => String(r.id)));
  const levels = (ctx as any).levels as Map<string, { intervals: Array<{ sides: Array<{ room: string }> }> }> | undefined;
  if (open.size > 1 && levels) {
    for (const plan of levels.values()) {
      for (const iv of plan.intervals ?? []) {
        const rs = (iv.sides ?? []).map((x) => x.room).filter((r) => open.has(r));
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rs[i] !== rs[j]) link(rs[i], rs[j]);
      }
    }
  }
  // a stair is an edge of the graph too, across levels (spec "Лестницы")
  for (const st of ((ctx.scene as any).stairs ?? []) as any[]) {
    const a = st?.from?.room;
    const b = st?.to?.room;
    if (typeof a === "string" && typeof b === "string") link(a, b);
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of g) out.set(k, [...v].sort());
  return out;
}
