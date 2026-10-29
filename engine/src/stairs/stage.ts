import type { Ctx } from "../ctx.js";
import type { Issue, Stage } from "../types.js";
import { msg } from "../report/messages.js";
import { round3 } from "../report/report.js";
import { placeStairs } from "./place.js";

const STAGE: Stage = "stairs";

export function stairsStage(ctx: Ctx): Issue[] {
  const issues: Issue[] = [];
  const geos = placeStairs(ctx);
  (ctx as any).stairs = geos;
  if (geos.length === 0) return issues;

  const pass: unknown[] = [];
  for (const g of geos) {
    const path = `/stairs/${g.i}`;
    if (g.bad) {
      issues.push({
        code: "STAIR_EXIT_OUTSIDE",
        stage: STAGE,
        path,
        msg: msg("STAIR_EXIT_OUTSIDE", {
          path,
          id: g.id,
          x: String(round3(g.bad.at[0])),
          z: String(round3(g.bad.at[1])),
          room: g.bad.room,
        }),
      });
      continue;
    }
    if (g.headroom) {
      issues.push({
        code: "STAIR_HEADROOM",
        stage: STAGE,
        path,
        msg: msg("STAIR_HEADROOM", {
          path,
          id: g.id,
          min: String(round3(g.headroom.min)),
          s0: String(round3(g.headroom.s0)),
          s1: String(round3(g.headroom.s1)),
        }),
      });
    }
    pass.push({ id: g.id, n: g.n, rise: g.rise, len: g.len, exit: g.exit, cut: g.cut });
  }
  // `stairs` sits after `decals` in the passport: the key is added last, and
  // only when the scene has stairs at all (demo-flat's golden has none)
  (ctx.passport as any).stairs = pass;
  return issues;
}
