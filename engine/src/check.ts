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
import { msg } from "./report/messages.js";
import { budgetIssues, type TriCount } from "./budget.js";

export function runCheck(
  raw: unknown,
  opts?: { until?: Stage; builtNav?: NavJson; facts?: Record<string, PropFact | null>; tris?: TriCount; missingShots?: { index: number; id: string; file: string }[]; builtCams?: { ref?: string | null }[]; missingAssets?: string[] },
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
  // budgets read the built dist/ and never gate a stage: they only add findings
  if (opts?.tris !== undefined) {
    for (const i of budgetIssues(ctx, opts.tris)) {
      // an unreadable model has unknown triangles: that blocks the check, it never stays a warn
      const unreadable = i.code === "TRI_PROP_BUDGET" && (i.data as any)?.unreadable === true;
      const isErr = unreadable || (i.code === "POINT_LIGHT_BUDGET" ? i.data?.level === "error" : CODES[i.code].level === "error");
      (isErr ? errors : warnings).push(i);
    }
  }

  // camera ↔ picture checks need a dist/ on disk: only the CLI passes `missingShots` (an empty list when nothing is missing)
  if (opts?.missingShots !== undefined && upToProps) {
    // `ref` is read from the built geometry, not the source scene: a ref
    // path whose file is missing is `null` in the dist, so there is no pair
    const built = opts?.builtCams;
    const cams = built !== undefined
      ? built
      : (((scene as any).cameras ?? []) as any[]).filter((c) => c && typeof c === "object");
    if (cams.length > 0 && !cams.some((c) => typeof c.ref === "string" && c.ref !== "")) {
      warnings.push({
        code: "CAMERA_NO_REF",
        stage: "routes",
        path: "/cameras",
        msg: msg("CAMERA_NO_REF", { n: String(cams.length) }),
      });
    }
    for (const m of opts.missingShots) {
      errors.push({
        code: "SHOT_MISSING",
        stage: "routes",
        path: `/cameras/${m.index}`,
        msg: msg("SHOT_MISSING", { id: m.id, file: m.file }),
      });
    }
  }
  // `build.json` lists cached assets the dist had to draw as placeholders:
  // an object without its GLB is a build error, never a silent box
  if (opts?.missingAssets !== undefined && upToProps) {
    // `assets.missing` holds asset ids: report the props that use a missing object asset, by prop id
    const missing = new Set(opts.missingAssets);
    const declared = (ctx.scene?.assets ?? {}) as Record<string, { kind?: string } | undefined>;
    for (const p of (ctx.scene?.props ?? []) as { id?: unknown; asset?: unknown }[]) {
      if (typeof p?.id !== "string" || typeof p.asset !== "string") continue;
      if (!missing.has(p.asset) || declared[p.asset]?.kind !== "object") continue;
      errors.push({
        code: "ASSET_MISSING",
        stage: "routes",
        path: `/props/${p.id}`,
        msg: msg("ASSET_MISSING", { id: p.id }),
      });
    }
  }

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
    const status = failedAt.has("routes") ? "fail" : !runRoutes ? "skipped" : "pass";
    stages.push({ stage: "routes", status: status as never });
  }
  const report = makeReport(stages, passport, errors, warnings);
  report.passport = roundReport(passport) as never;
  return { report, ctx };
}



/** `build --apply-fixes` moves a prop out of a wall only up to this far (m) */
export const FIX_MAX = 0.1;

/**
 * `build --apply-fixes`: runs `check`, moves every prop a `PROP_HITS_WALL`
 * error reaches into the wall by at most FIX_MAX to the error's `fix.at`, and
 * checks again (a shift can uncover the next one, so a few passes). A deeper
 * hit is left alone and stays an error. Returns the patched scene, the last
 * check and one `WARN` line per moved prop.
 */
export function applyFixes(raw: unknown): {
  raw: unknown;
  report: Report;
  ctx: Ctx;
  warns: string[];
  /** prop id → where it stands now */
  moved: Record<string, [number, number]>;
} {
  const scene = JSON.parse(JSON.stringify(raw ?? null));
  const warns: string[] = [];
  const moved: Record<string, [number, number]> = Object.create(null);
  let run = runCheck(scene);
  for (let pass = 0; pass < 5; pass++) {
    let again = false;
    for (const e of run.report.errors) {
      if (e.code !== "PROP_HITS_WALL") continue;
      const m = /^\/props\/(\d+)\/at$/.exec(e.path);
      const to = (e.fix as { at?: unknown } | undefined)?.at;
      if (!m || !Array.isArray(to) || to.length !== 2) continue;
      const p = scene?.props?.[Number(m[1])];
      if (!p || !Array.isArray(p.at)) continue;
      // the limit reads the exact penetration from lint, not the travel:
      // on an arc `fix.at` runs longer than the depth (corners meet the
      // curve at other normals), so travel minus clearance would refuse a
      // hit that fits the limit
      const d = (e.data as { depth?: unknown } | undefined)?.depth;
      const deep = typeof d === "number" && Number.isFinite(d)
        ? d > FIX_MAX
        : Math.hypot(Number(to[0]) - p.at[0], Number(to[1]) - p.at[1]) - 0.01 > FIX_MAX;
      if (deep) continue;
      const shift = Math.hypot(Number(to[0]) - p.at[0], Number(to[1]) - p.at[1]);
      warns.push(`WARN PROP_HITS_WALL ${String(p.id)}: at [${p.at.join(", ")}] -> [${to.join(", ")}] (${shift.toFixed(3)} m)`);
      p.at = [Number(to[0]), Number(to[1])];
      moved[String(p.id)] = p.at;
      again = true;
    }
    if (!again) break;
    run = runCheck(scene);
  }
  return { raw: scene, report: run.report, ctx: run.ctx, warns, moved };
}
