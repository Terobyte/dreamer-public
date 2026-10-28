import { validate } from "./schema/validate.js";
import { emptyPassport, makeReport, roundReport, STAGES } from "./report/report.js";
import { planStage } from "./plan/lint.js";
import { openingsStage } from "./openings/stage.js";
import { placeProps } from "./props/place.js";
import { lintProps } from "./props/lint.js";
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
  const want: Stage[] = STAGES.slice(0, untilIdx + 1);
  if (!planFailed && want.includes("openings")) {
    push(openingsStage(ctx));
  }
  const openingsFailed = errors.some((e) => e.stage === "openings");
  if (!planFailed && !openingsFailed && want.includes("props")) {
    ctx.props = placeProps(ctx);
    push(lintProps(ctx));
  }

  const failedAt = new Set<Stage>(errors.map((e) => e.stage));
  const stages = STAGES.map((s, i) => {
    if (s === "stairs") return { stage: s, status: "skipped" as const };
    if (i > untilIdx) return { stage: s, status: "skipped" as const };
    if (s === "openings" && !want.includes("openings")) return { stage: s, status: "pass" as const };
    if (failedAt.has(s)) return { stage: s, status: "fail" as const };
    const earlierFail = STAGES.slice(0, i).some((x) => failedAt.has(x));
    if (earlierFail) return { stage: s, status: "skipped" as const };
    return { stage: s, status: "pass" as const };
  });
  const report = makeReport(stages, passport, errors, warnings);
  report.passport = roundReport(passport) as never;
  return { report, ctx };
}


