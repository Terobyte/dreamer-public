import { validate } from "./schema/validate.js";
import { emptyPassport, makeReport, roundReport, STAGES } from "./report/report.js";
import { planStage } from "./plan/lint.js";
import { openingsStage } from "./openings/stage.js";
import { stairsStage } from "./stairs/stage.js";
import { placeProps } from "./props/place.js";
import { lintProps } from "./props/lint.js";
import { decalsStage } from "./decals/place.js";
import { checkCameras } from "./cameras/check.js";
import { navStage } from "./nav/grid.js";
import { routesStage } from "./routes/stage.js";
import type { Ctx } from "./ctx.js";
import type { PropFact } from "./props/fact.js";
import type { NavJson, Report, Stage, Issue } from "./types.js";
import { CODES } from "./report/codes.js";

export function runCheck(
  raw: unknown,
  opts?: { until?: Stage; builtNav?: NavJson; facts?: Record<string, PropFact | null> },
): { report: Report; ctx: Ctx } {
  const until = opts?.until ?? "nav";
  const untilIdx = STAGES.indexOf(until);
  const passport = emptyPassport();

  const { scene, issues } = validate(raw);
  if (!scene) {
    const stages = STAGES.map((s, i) => ({
      stage: s,
      status: i === 0 ? ("fail" as const) : ("skipped" as const),
    }));
    if (opts?.builtNav !== undefined) stages.push({ stage: "routes", status: "skipped" });
    const report = makeReport(stages, passport, issues, []);
    report.passport = roundReport(passport) as never;
    return { report, ctx: { scene: (raw ?? {}) as never, passport } };
  }

  const ctx: Ctx = { scene, passport, facts: opts?.facts };
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const push = (list: Issue[]): void => {
    for (const i of list) (CODES[i.code].level === "warn" ? warnings : errors).push(i);
  };

  const want: Stage[] = STAGES.slice(0, untilIdx + 1);
  if (want.includes("plan")) push(planStage(ctx));

  const planFailed = !want.includes("plan") || errors.some((e) => e.stage === "plan");
  if (!planFailed && want.includes("openings")) {
    push(openingsStage(ctx));
  }
  const openingsFailed = errors.some((e) => e.stage === "openings");
  if (!planFailed && !openingsFailed && want.includes("stairs")) {
    push(stairsStage(ctx));
  }
  const stairsFailed = errors.some((e) => e.stage === "stairs");
  if (!planFailed && !openingsFailed && !stairsFailed && want.includes("props")) {
    ctx.props = placeProps(ctx);
    push(lintProps(ctx));
  }

  const propsFailed = errors.some((e) => e.stage === "props");
  const upToProps = !planFailed && !openingsFailed && !stairsFailed && !propsFailed;
  if (upToProps && want.includes("decals")) {
    push(decalsStage(ctx));
  }
  const decalsFailed = errors.some((e) => e.stage === "decals");
  if (upToProps && !decalsFailed && want.includes("cameras")) {
    push(checkCameras(ctx));
  }

  const camerasFailed = errors.some((e) => e.stage === "cameras");
  if (upToProps && !decalsFailed && !camerasFailed && want.includes("nav")) {
    push(navStage(ctx));
  }

  // `routes` only exists with `--built`: it walks the nav grid of a dist/
  // that is already on disk, so it is appended after `nav`, never in STAGES.
  const navFailed = errors.some((e) => e.stage === "nav");
  const built = opts?.builtNav;
  const runRoutes = built !== undefined && upToProps && !decalsFailed && !camerasFailed && !navFailed;
  if (runRoutes) push(routesStage(ctx, built));

  const failedAt = new Set<Stage>(errors.map((e) => e.stage));
  const stages = STAGES.map((s, i) => {
    // `stairs` is only a stage when the scene has any (spec "Лестницы")
    if (s === "stairs" && ((scene as any).stairs ?? []).length === 0) return { stage: s, status: "skipped" as const };
    if (i > untilIdx) return { stage: s, status: "skipped" as const };
    if (s === "openings" && !want.includes("openings")) return { stage: s, status: "pass" as const };
    if (failedAt.has(s)) return { stage: s, status: "fail" as const };
    const earlierFail = STAGES.slice(0, i).some((x) => failedAt.has(x));
    if (earlierFail) return { stage: s, status: "skipped" as const };
    return { stage: s, status: "pass" as const };
  });
  if (built !== undefined) {
    const status = !runRoutes ? "skipped" : failedAt.has("routes") ? "fail" : "pass";
    stages.push({ stage: "routes", status: status as never });
  }
  const report = makeReport(stages, passport, errors, warnings);
  report.passport = roundReport(passport) as never;
  return { report, ctx };
}


