#!/usr/bin/env node --import tsx
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { parseScene } from "../src/schema/parse.js";
import { emptyPassport, makeReport } from "../src/report/report.js";
import { runCheck, applyFixes } from "../src/check.js";
import type { TriCount } from "../src/budget.js";
import { topSvg } from "../src/report/topsvg.js";
import { buildNav } from "../src/nav/grid.js";
import { writeDist, bundleRuntime } from "../src/build/write.js";
import { shotBaseNames } from "../src/build/shotnames.js";
import { runShots, SHOTS_DEFAULTS } from "../src/build/shots.js";
import { runAssets, missingAssets } from "../src/assets/run.js";
import { MuseImageProvider } from "../src/assets/providers/muse-image.js";
import { Sam3dProvider } from "../src/assets/providers/sam3d.js";
import type { Issue, NavJson, Report } from "../src/types.js";
import { mark } from "../src/report/timing.js";
import type { PropFact } from "../src/props/fact.js";
import { writeClipfacts } from "../src/runtime/stage/clipfacts.js";

const USAGE =
  "usage: dreamer check <scene> [--report <path>] [--built <dist>]\n" +
  "       dreamer build <scene> --out <dir> [--assets none|cache|live] [--cache <dir>] [--max-dollars <n>] [--apply-fixes]\n" +
  "       dreamer shots <dist> [--size 1280x720] [--ready-timeout <s>]\n" +
  "       dreamer clipfacts <cast dir>";

/**
 * `undefined` = flag absent, `null` = flag present but its value is missing
 * or is itself another flag (so it can't be swallowed as a value), string =
 * the value.
 */
function flag(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return null;
  return v;
}

/**
 * The difference with the previous report at the same `--report` path, keyed
 * by code + path (spec "Сообщения"): what the author fixed and what appeared.
 */
function reportDiff(prev: Report, now: Report): { fixed: Issue[]; new: Issue[] } {
  const key = (i: Issue): string => `${i.code}\u0000${i.path}`;
  const all = (r: Report): Issue[] => [...r.errors, ...r.warnings];
  const was = new Map(all(prev).map((i) => [key(i), i]));
  const is = new Map(all(now).map((i) => [key(i), i]));
  return {
    fixed: [...was].filter(([k]) => !is.has(k)).map(([, i]) => i),
    new: [...is].filter(([k]) => !was.has(k)).map(([, i]) => i),
  };
}

/** The report a scene that does not even parse gets: schema fails, rest skipped. */
function parseFailReport(issues: unknown[], builtFlag?: string | null): Report {
  const stages = ["schema", "plan", "openings", "stairs", "props", "decals", "cameras", "nav"].map((s, i) => ({
    stage: s as never,
    status: (i === 0 ? "fail" : "skipped") as "fail" | "skipped",
  }));
  if (builtFlag !== undefined) stages.push({ stage: "routes" as never, status: "skipped" });
  return makeReport(stages as never, emptyPassport(), issues as never, []);
}

/**
 * Prints the report, diffs it against whatever is already on disk at `rp`
 * (if anything) and writes it back: shared by every outcome `check` can
 * reach, including a scene that fails to parse at all.
 */
function printAndDiff(rp: string, report: Report): void {
  if (existsSync(rp)) {
    try {
      const prev = JSON.parse(readFileSync(rp, "utf-8")) as Report;
      const diff = reportDiff(prev, report);
      report.diff = diff;
    } catch {
      // an unreadable previous report is simply no baseline
    }
  }
  const out = JSON.stringify(report, null, 2);
  console.log(out);
  if (report.diff) {
    for (const i of report.diff.fixed) console.log(`исправлено: ${i.code} ${i.path}`);
    for (const i of report.diff.new) console.log(`появилось: ${i.code} ${i.path}`);
  }
  // a missing shot is the one finding a reader greps for by camera id: say it in one line
  for (const e of report.errors ?? []) if (e.code === "SHOT_MISSING") console.log(`${e.code}: ${e.msg}`);
  writeFileSync(rp, out);
}

async function main(): Promise<number> {
  // every import above is loaded by now: what follows is the command itself
  mark("main");
  const args = process.argv.slice(2);
  if (args[0] === "build") return runBuild(args);
  if (args[0] === "shots") return runShotsCmd(args);
  if (args[0] === "runtime" && args[1]) {
    // re-bundle runtime.js into a built dist: an old world plays with the current engine (film, fixes)
    await bundleRuntime(join(args[1], "runtime.js"));
    console.log(`runtime: ${join(args[1], "runtime.js")}`);
    return 0;
  }
  if (args[0] === "clipfacts" && args[1]) {
    // G4: <cast dir>/clipfacts.json: contact_y / face_dir / head_y / lying of every clip of every actor
    // (static import: this tsx's vendored ESM parser fails on a dynamic import() in this file)
    // B72: a missing cast is a usage error (exit 2), like every other command, not a stack trace
    if (!existsSync(join(args[1], "cast.json"))) {
      console.error(`clipfacts: no cast.json in ${args[1]}`);
      return 2;
    }
    for (const w of await writeClipfacts(args[1])) console.warn(w);
    console.log(`clipfacts: ${join(args[1], "clipfacts.json")}`);
    return 0;
  }
  if (args[0] !== "check" || !args[1]) {
    console.error(USAGE);
    return 2;
  }
  const scenePath = args[1];
  const reportFlag = flag(args, "--report");
  if (reportFlag === null) {
    console.error("--report requires a value");
    return 2;
  }
  const reportPath = reportFlag ?? null;

  if (!existsSync(scenePath)) {
    console.error(`file not found: ${scenePath}`);
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(scenePath, "utf-8");
  } catch (e) {
    console.error(String(e));
    return 2;
  }
  try {
    const builtFlag = flag(args, "--built");
    if (builtFlag === null) {
      console.error("--built requires a value");
      return 2;
    }
    // a missing nav is a usage error, so it wins over a scene that does not parse
    if (builtFlag !== undefined && !existsSync(join(builtFlag, "nav.json"))) {
      console.error("built: nav.json not found");
      return 2;
    }
    const { raw, issues } = parseScene(text);
    if (raw === null && issues.length > 0) {
      const report = parseFailReport(issues, builtFlag);
      const rp = reportPath ?? defaultReportPath(scenePath);
      printAndDiff(rp, report);
      return 1;
    }
    let builtNav: NavJson | undefined;
    let facts: Record<string, PropFact | null> | undefined;
    let tris: TriCount | undefined;
    let missingShots: { index: number; id: string; file: string }[] | undefined;
    let builtCams: { ref?: string | null }[] | undefined;
    let missingAssets: string[] | undefined;
    if (builtFlag !== undefined) {
      const navPath = join(builtFlag, "nav.json");
      builtNav = JSON.parse(readFileSync(navPath, "utf-8"));
      // the same dist/ also carries what every prop's model measures, so
      // `--built` checks the props by fact instead of the author's `size`
      const buildPath = join(builtFlag, "build.json");
      if (existsSync(buildPath)) {
        const buildJson = JSON.parse(readFileSync(buildPath, "utf-8"));
        // B71: build.json is read from disk -- a tris block of another shape is no tris count
        const t = buildJson.tris;
        if (t && typeof t === "object" && t.by_prop && typeof t.by_prop === "object") tris = t;
        const props = buildJson.props as Record<string, { fact: PropFact | null }> | undefined;
        if (props) {
          facts = Object.fromEntries(Object.entries(props).map(([id, p]) => [id, p?.fact ?? null]));
        }
        const missing = (buildJson.assets as { missing?: unknown } | undefined)?.missing;
        if (Array.isArray(missing)) {
          missingAssets = missing.filter((m): m is string => typeof m === "string");
        }
      }
    }
    if (builtFlag !== undefined) {
      missingShots = [];
      // a directory at the shot path is not a picture
      const isShotFile = (p: string): boolean => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      };
      // once `shots` has been run, every camera must have its picture;
      // a missing `shots/` dir means every picture is missing
      if (existsSync(join(builtFlag, "geometry.json"))) {
        // the scene decides which cameras exist; the dist only lends refs by id
        const geoCams: { id: string; ref?: string | null }[] = JSON.parse(readFileSync(join(builtFlag, "geometry.json"), "utf-8")).cameras ?? [];
        const sceneCams = ((raw as any)?.cameras ?? []).filter(
          (c: unknown): c is { id: string } => !!c && typeof c === "object" && typeof (c as { id: unknown }).id === "string",
        );
        builtCams = sceneCams.map((c: { id: string }) => ({ ref: geoCams.find((g) => g.id === c.id)?.ref ?? null }));
        missingShots = shotBaseNames(sceneCams)
          .map((n, index) => ({ index, id: sceneCams[index]!.id, file: `${n}.png` }))
          .filter((m) => !isShotFile(join(builtFlag, "shots", m.file)));
      } else {
        // without geometry.json the dist cannot be trusted: every scene
        // camera counts as missing its shot (builtCams stays undefined so
        // the CAMERA_NO_REF check falls back to the scene cameras)
        const sceneCams = ((raw as any)?.cameras ?? []).filter(
          (c: unknown): c is { id: string } => !!c && typeof c === "object" && typeof (c as { id: unknown }).id === "string",
        );
        missingShots = shotBaseNames(sceneCams).map((n, index) => ({
          index,
          id: sceneCams[index]!.id,
          file: `${n}.png`,
        }));
      }
    }
    const { report, ctx } = runCheck(raw, { builtNav, facts, tris, missingShots, builtCams, missingAssets });
    const sceneName = typeof ctx.scene?.name === "string" ? ctx.scene.name : undefined;
    const rp = reportPath ?? defaultReportPath(scenePath, sceneName);
    printAndDiff(rp, report);
    const name = basename(scenePath).replace(/\.scene\.json$/, "");
    writeFileSync(join(dirname(rp), `${name}.top.svg`), topSvg(ctx));
    const nav = ctx.nav ?? buildNav(ctx);
    writeFileSync(join(dirname(rp), `${name}.nav.json`), JSON.stringify(nav));
    return report.ok ? 0 : 1;
  } catch (e) {
    console.error(String(e));
    return 2;
  }
}

/**
 * `build` = the whole of `check`, then the scene compiled into `--out`.
 * A scene with errors is never built, and nothing is ever written next to
 * the scene itself: the report, the plan svg and the nav grid go to `dist/`.
 */
async function runBuild(args: string[]): Promise<number> {
  const started = Date.now();
  const scenePath = args[1];
  const outDir = flag(args, "--out");
  if (!scenePath || scenePath.startsWith("--") || outDir === undefined) {
    console.error(USAGE);
    return 2;
  }
  if (outDir === null) {
    console.error("--out requires a value");
    return 2;
  }
  const assetsFlag = flag(args, "--assets");
  if (assetsFlag === null) {
    console.error("--assets requires a value");
    return 2;
  }
  const assets = assetsFlag ?? "none";
  if (assets !== "none" && assets !== "cache" && assets !== "live") {
    console.error(`unknown --assets value: ${assets}`);
    return 2;
  }
  const cacheFlag = flag(args, "--cache");
  if (cacheFlag === null) {
    console.error("--cache requires a value");
    return 2;
  }
  if (assets !== "none" && cacheFlag === undefined) {
    console.error(`--assets ${assets} requires --cache <dir>`);
    return 2;
  }
  // The cap is a hard gate: no provider is even constructed without it, so a
  // typo can never reach a paid endpoint.
  const dollarsFlag = flag(args, "--max-dollars");
  let maxDollars: number | undefined;
  if (assets === "live") {
    if (dollarsFlag === undefined || dollarsFlag === null) {
      console.error("--assets live requires --max-dollars <n>");
      return 2;
    }
    maxDollars = Number(dollarsFlag);
    if (!Number.isFinite(maxDollars) || maxDollars <= 0) {
      console.error(`--max-dollars must be a positive number: ${dollarsFlag}`);
      return 2;
    }
  }
  if (!existsSync(scenePath)) {
    console.error(`file not found: ${scenePath}`);
    return 2;
  }
  try {
    const { raw, issues } = parseScene(readFileSync(scenePath, "utf-8"));
    if (raw === null && issues.length > 0) {
      console.log(JSON.stringify(parseFailReport(issues), null, 2));
      return 1;
    }
    // `--apply-fixes`: small wall hits are moved to their `fix.at`, said as WARN
    const fixed = args.includes("--apply-fixes") ? applyFixes(raw) : null;
    for (const w of fixed?.warns ?? []) console.log(w);
    const { report, ctx } = fixed ?? runCheck(raw);
    if (report.errors.length > 0) {
      console.log(JSON.stringify(report, null, 2));
      return 1;
    }
    const live = assets === "live";
    // A fully populated cache needs no live provider at all, so it must not
    // require an API key: only construct them once something is missing.
    const needsLive = live && (cacheFlag === undefined || missingAssets(ctx.scene, cacheFlag, dirname(scenePath)).length > 0);
    const assetReport = await runAssets(ctx.scene, {
      mode: assets,
      cacheDir: cacheFlag,
      maxDollars,
      sceneDir: dirname(scenePath),
      image: needsLive ? new MuseImageProvider() : undefined,
      object: needsLive ? new Sam3dProvider() : undefined,
    });
    await writeDist(ctx, report, outDir, {
      startedAt: started,
      assets: assetReport,
      cacheDir: cacheFlag,
      scenePath,
      fixes: fixed?.warns,
      moved: fixed?.moved,
    });
    return 0;
  } catch (e) {
    console.error(String(e));
    return 2;
  }
}

/**
 * `shots` works on an already built `dist/`, so it never parses the scene and
 * never touches a provider: the only thing it can fail on is a page that does
 * not become ready, and that is exit 2.
 */
async function runShotsCmd(args: string[]): Promise<number> {
  const dist = args[1];
  if (!dist || dist.startsWith("--")) {
    console.error(USAGE);
    return 2;
  }
  if (!existsSync(join(dist, "geometry.json"))) {
    console.error(`not a built dist/: ${dist}`);
    return 2;
  }
  let { width, height, readyTimeoutMs } = SHOTS_DEFAULTS;
  const sizeFlag = flag(args, "--size");
  if (sizeFlag === null) {
    console.error("--size requires a value");
    return 2;
  }
  if (sizeFlag !== undefined) {
    const m = /^(\d+)x(\d+)$/.exec(sizeFlag);
    if (!m) {
      console.error(`--size must look like 1280x720: ${sizeFlag}`);
      return 2;
    }
    width = Number(m[1]);
    height = Number(m[2]);
  }
  const timeoutFlag = flag(args, "--ready-timeout");
  if (timeoutFlag === null) {
    console.error("--ready-timeout requires a value");
    return 2;
  }
  if (timeoutFlag !== undefined) {
    const s = Number(timeoutFlag);
    if (!Number.isFinite(s) || s <= 0) {
      console.error(`--ready-timeout must be a positive number of seconds: ${timeoutFlag}`);
      return 2;
    }
    readyTimeoutMs = s * 1000;
  }
  try {
    return await runShots(dist, { width, height, readyTimeoutMs });
  } catch (e) {
    console.error(String(e));
    return 2;
  }
}

function defaultReportPath(scenePath: string, sceneName?: string): string {
  const dir = dirname(scenePath);
  const base = sceneName ?? basename(scenePath).replace(/\.scene\.json$/, "");
  return join(dir, `${base}.check.json`);
}

const code = await main();
mark("exit");
process.exit(code);
