import type { Ctx } from "./ctx.js";
import type { Issue } from "./types.js";
import { msg } from "./report/messages.js";
import { levelY, pointInPoly } from "./nav/floor.js";

/** Budget numbers live here so they can be moved in one place. */
export const SMALL_MAX_M = 0.5;
export const FURNITURE_MAX_M = 2;
export const TRI_LIMITS = { small: 1000, furniture: 5000, large: 8000 } as const;
export const SCENE_TRI_LIMIT = 300_000;
export const ROOM_POINT_LIGHTS = 2;
export const SCENE_POINT_LIGHTS = 8;

export type PropClass = keyof typeof TRI_LIMITS;

export interface TriCount {
  total: number;
  by_prop: Record<string, number>;
}

export function propClass(size: { w?: number; d?: number; h?: number }): PropClass {
  const m = Math.max(size.w ?? 0, size.d ?? 0, size.h ?? 0);
  return m <= SMALL_MAX_M ? "small" : m <= FURNITURE_MAX_M ? "furniture" : "large";
}

/** Built-only checks: triangles per prop, per scene, and point lights. */
export function budgetIssues(ctx: Ctx, tris: TriCount): Issue[] {
  const issues: Issue[] = [];
  const scene: any = ctx.scene;
  ((scene.props ?? []) as any[]).forEach((p, i) => {
    const n = tris.by_prop[String(p?.id)];
    if (typeof n !== "number" || !p?.size) return;
    const limit = TRI_LIMITS[propClass(p.size)];
    if (n <= limit) return;
    issues.push({
      code: "TRI_PROP_BUDGET",
      stage: "routes",
      path: `/props/${i}`,
      msg: msg("TRI_PROP_BUDGET", { id: String(p.id), tris: String(n), limit: String(limit) }),
      data: { id: String(p.id), tris: n, limit },
    });
  });
  if (tris.total > SCENE_TRI_LIMIT) {
    issues.push({
      code: "TRI_SCENE_BUDGET",
      stage: "routes",
      path: "/",
      msg: msg("TRI_SCENE_BUDGET", { tris: String(tris.total), limit: String(SCENE_TRI_LIMIT) }),
      data: { tris: tris.total, limit: SCENE_TRI_LIMIT },
    });
  }

  const points = ((scene.lights ?? []) as any[]).map((l, i) => ({ l, i })).filter((x) => x.l?.kind === "point");
  const perRoom = new Map<string, number>();
  for (const { l } of points) {
    const pos = l.pos;
    if (!Array.isArray(pos)) continue;
    // rooms may share one outline on different floors: the lamp belongs to
    // the room whose vertical span holds its height, not to every plan hit
    const hits = (ctx.rooms ?? []).filter((r: any) => r.outline && pointInPoly([pos[0], pos[2]], r.outline));
    const y = typeof pos[1] === "number" ? pos[1] : null;
    const room =
      y === null
        ? hits[0]
        : hits.find((r: any) => {
            const base = levelY(ctx, String(r.level));
            const h = typeof r.height === "number" ? r.height : 0;
            return y + 1e-6 >= base && y - 1e-6 <= base + h;
          });
    if (room) perRoom.set(String((room as any).id), (perRoom.get(String((room as any).id)) ?? 0) + 1);
  }
  for (const [room, n] of perRoom) {
    if (n <= ROOM_POINT_LIGHTS) continue;
    issues.push({
      code: "POINT_LIGHT_BUDGET",
      stage: "routes",
      path: "/lights",
      msg: msg("POINT_LIGHT_BUDGET", { room, n: String(n), limit: String(ROOM_POINT_LIGHTS) }),
      data: { room, n, limit: ROOM_POINT_LIGHTS, level: "warn" },
    });
  }
  if (points.length > SCENE_POINT_LIGHTS) {
    issues.push({
      code: "POINT_LIGHT_BUDGET",
      stage: "routes",
      path: "/lights",
      msg: msg("POINT_LIGHT_BUDGET", { room: "", n: String(points.length), limit: String(SCENE_POINT_LIGHTS) }),
      data: { n: points.length, limit: SCENE_POINT_LIGHTS, level: "error" },
    });
  }
  return issues;
}
