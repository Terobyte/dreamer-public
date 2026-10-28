import { validate } from "./schema/validate.js";
import { emptyPassport, makeReport, STAGES } from "./report/report.js";
import type { Ctx } from "./ctx.js";
import type { Report, Stage } from "./types.js";

export function runCheck(raw: unknown, opts?: { until?: Stage }): { report: Report; ctx: Ctx } {
  const until = opts?.until ?? "nav";
  const untilIdx = STAGES.indexOf(until);
  const passport = emptyPassport();

  const { scene, issues } = validate(raw);
  if (!scene) {
    const stages = STAGES.map((s, i) => ({
      stage: s,
      status: i === 0 ? ("fail" as const) : ("skipped" as const),
    }));
    const report = makeReport(stages, passport, issues, []);
    return { report, ctx: { scene: (raw ?? {}) as never, passport } };
  }

  const stages = STAGES.map((s, i) => ({
    stage: s,
    status: (s === "stairs" ? "skipped" : i <= untilIdx ? ("pass" as const) : ("skipped" as const)),
  }));
  const ctx: Ctx = { scene, passport };
  const report = makeReport(stages, passport, [], []);
  return { report, ctx };
}


