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
  const out = new Map<string, string[]>();
  for (const [k, v] of g) out.set(k, [...v].sort());
  return out;
}
