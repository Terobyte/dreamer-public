import type { Ctx } from "../ctx.js";
import type { Issue, NavJson, Stage } from "../types.js";
import { msg } from "../report/messages.js";
import { round3 } from "../report/report.js";
import { findRouteLevels, gridOf, nearestWalkable, nearestWalkableAny } from "./astar.js";
import { blockerBetween, waypoint } from "./waypoints.js";

const STAGE: Stage = "routes";

/**
 * Walk every authored route over the built `nav.json`. One route gives at most
 * one `ROUTE_BLOCKED`: the first target it cannot reach, addressed by the
 * index of that target in `path`.
 */
export function routesStage(ctx: Ctx, nav: NavJson): Issue[] {
  const issues: Issue[] = [];
  const level = String(((nav.layers ?? []) as any[])[0]?.level ?? "L0");
  const routes = ((ctx.scene as any).routes ?? []) as any[];

  routes.forEach((route, ri) => {
    const points = (route?.path ?? []) as unknown[];
    let cur: { level: string; at: [number, number] } | null = null;
    for (let pi = 0; pi < points.length; pi++) {
      const res = waypoint(ctx, nav, level, points[pi]);
      const path = `/routes/${ri}/path/${pi}`;
      if (!res.ok) {
        issues.push({
          code: "REF_UNKNOWN",
          stage: STAGE,
          path,
          msg: msg("REF_UNKNOWN", { path, kind: res.kind, v: res.v, have: res.have }),
        });
        return;
      }
      const wp = res.wp;
      if (cur === null) {
        const grid = gridOf(nav, wp.level);
        if (!grid || nearestWalkable(grid, wp.at, wp.radius) === null) {
          const stuck = (grid && nearestWalkableAny(grid, wp.at)) || wp.at;
          const what = blockerBetween(ctx, wp.level, stuck, wp.at);
          issues.push({
            code: "ROUTE_BLOCKED",
            stage: STAGE,
            path,
            msg: msg("ROUTE_BLOCKED", {
              route: String(route?.id ?? ri),
              x: String(round3(stuck[0])),
              z: String(round3(stuck[1])),
              target: wp.label,
              what,
            }),
          });
          return;
        }
        cur = { level: wp.level, at: wp.at };
        continue;
      }
      const r = findRouteLevels(nav, cur, { level: wp.level, at: wp.at });
      if (r.ok) {
        cur = { level: wp.level, at: wp.at };
        continue;
      }
      const what = blockerBetween(ctx, r.stuck.level, r.stuck.at, wp.at);
      issues.push({
        code: "ROUTE_BLOCKED",
        stage: STAGE,
        path,
        msg: msg("ROUTE_BLOCKED", {
          route: String(route?.id ?? ri),
          x: String(round3(r.stuck.at[0])),
          z: String(round3(r.stuck.at[1])),
          target: wp.label,
          what,
        }),
      });
      return;
    }
  });
  return issues;
}
