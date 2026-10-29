import type { Ctx } from "../ctx.js";
import type { Issue } from "../types.js";
import { msg } from "../report/messages.js";
import { round3 } from "../report/report.js";

/** The real bound of a prop's model, in the prop's own system, before yaw. */
export interface PropFact {
  w: number;
  d: number;
  h: number;
}

/** How far fact and `size` may differ on an axis before `check` says so. */
const FACT_TOLERANCE = 0.2;

/**
 * The bound a placed GLB actually occupies: the normalized model's own box
 * times the uniform scale the build fitted it with. The author's `size` is
 * only a promise; this is what the world has in it. Kept at full precision
 * (no `round3` here) — `fix.size` below rounds only for display, since
 * rounding before the >20% comparison could round a real gap away.
 */
export function factOf(glb: PropFact, scale: number): PropFact {
  return { w: glb.w * scale, d: glb.d * scale, h: glb.h * scale };
}

/**
 * `check --built` knows every prop's measured bound, so it can hold the
 * author's `size` to the model instead of the other way round: an axis off
 * by more than a fifth is a warning carrying the measured box as the fix.
 * Plausibility against `cat` stays on the author's `size` (see `lintProps`):
 * a model that came out wrong must not make a sane `size` look odd.
 */
export function factIssues(ctx: Ctx): Issue[] {
  const facts = ctx.facts;
  if (!facts) return [];
  const issues: Issue[] = [];
  ((ctx.scene as any)?.props ?? []).forEach((raw: any, i: number) => {
    const fact = facts[String(raw.id)];
    const size = raw?.size;
    if (!fact || !size) return;
    const off = (["w", "d", "h"] as const).some((k) => {
      const want = size[k];
      return typeof want === "number" && want > 0 && Math.abs(fact[k] - want) / want > FACT_TOLERANCE;
    });
    if (!off) return;
    const rounded = { w: round3(fact.w), d: round3(fact.d), h: round3(fact.h) };
    issues.push({
      code: "PROP_SIZE_ODD",
      stage: "props",
      path: `/props/${i}/size`,
      msg: msg("PROP_SIZE_ODD", {
        id: String(raw.id),
        fact: "1",
        w: String(rounded.w),
        d: String(rounded.d),
        h: String(rounded.h),
      }),
      fix: { size: rounded },
    });
  });
  return issues;
}
