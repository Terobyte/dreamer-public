import { validate } from "./schema/validate.js";
import { emptyPassport, makeReport, roundReport, STAGES } from "./report/report.js";
import { planStage } from "./plan/lint.js";
import type { Ctx } from "./ctx.js";
import type { Report, Stage, Issue } from "./types.js";
import { CODES } from "./report/codes.js";

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
    report.passport = roundReport(passport) as never;
    return { report, ctx: { scene: (raw ?? {}) as never, passport } };
  }

  const ctx: Ctx = { scene, passport };
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const push = (list: Issue[]): void => {
    for (const i of list) (CODES[i.code].level === "warn" ? warnings : errors).push(i);
  };

  const planIssues = planStage(ctx);
  push(planIssues);

  const planFailed = errors.some((e) => e.stage === "plan");
  const stages = STAGES.map((s, i) => {
    if (s === "stairs") return { stage: s, status: "skipped" as const };
    if (i > untilIdx) return { stage: s, status: "skipped" as const };
    if (s === "schema" || s === "plan") {
      const failed = s === "schema" ? false : planFailed;
      return { stage: s, status: (failed ? "fail" : "pass") as "fail" | "pass" };
    }
    if (planFailed) return { stage: s, status: "skipped" as const };
    return { stage: s, status: "pass" as const };
  });
  const report = makeReport(stages, passport, errors, warnings);
  report.passport = roundReport(passport) as never;
  return { report, ctx };
}


