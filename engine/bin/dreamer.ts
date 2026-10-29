#!/usr/bin/env node --import tsx
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { parseScene } from "../src/schema/parse.js";
import { emptyPassport, makeReport } from "../src/report/report.js";
import { runCheck } from "../src/check.js";
import { topSvg } from "../src/report/topsvg.js";
import { buildNav } from "../src/nav/grid.js";
import { writeDist } from "../src/build/write.js";
import { runAssets, missingAssets } from "../src/assets/run.js";
import { MuseImageProvider } from "../src/assets/providers/muse-image.js";
import { Sam3dProvider } from "../src/assets/providers/sam3d.js";
import type { Report } from "../src/types.js";

const USAGE =
  "usage: dreamer check <scene> [--report <path>]\n" +
  "       dreamer build <scene> --out <dir> [--assets none|cache|live] [--cache <dir>] [--max-dollars <n>]";

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

/** The report a scene that does not even parse gets: schema fails, rest skipped. */
function parseFailReport(issues: unknown[]): Report {
  const stages = ["schema", "plan", "openings", "stairs", "props", "decals", "cameras", "nav"].map((s, i) => ({
    stage: s as never,
    status: (i === 0 ? "fail" : "skipped") as "fail" | "skipped",
  }));
  return makeReport(stages as never, emptyPassport(), issues as never, []);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "build") return runBuild(args);
  if (args[0] !== "check" || !args[1]) {
    console.error(USAGE);
    return 2;
  }
  const scenePath = args[1];
  let reportPath: string | null = null;
  const ri = args.indexOf("--report");
  if (ri >= 0) reportPath = args[ri + 1] ?? null;

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
    const { raw, issues } = parseScene(text);
    if (raw === null && issues.length > 0) {
      const stages = ["schema", "plan", "openings", "stairs", "props", "decals", "cameras", "nav"].map((s, i) => ({
        stage: s as never,
        status: (i === 0 ? "fail" : "skipped") as "fail" | "skipped",
      }));
      const report = makeReport(stages as never, emptyPassport(), issues, []);
      const out = JSON.stringify(report, null, 2);
      console.log(out);
      const rp = reportPath ?? defaultReportPath(scenePath);
      writeFileSync(rp, out);
      return 1;
    }
    const { report, ctx } = runCheck(raw);
    const out = JSON.stringify(report, null, 2);
    console.log(out);
    const sceneName = typeof ctx.scene?.name === "string" ? ctx.scene.name : undefined;
    const rp = reportPath ?? defaultReportPath(scenePath, sceneName);
    writeFileSync(rp, out);
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
    const { report, ctx } = runCheck(raw);
    if (report.errors.length > 0) {
      console.log(JSON.stringify(report, null, 2));
      return 1;
    }
    const live = assets === "live";
    // A fully populated cache needs no live provider at all, so it must not
    // require an API key: only construct them once something is missing.
    const needsLive = live && (cacheFlag === undefined || missingAssets(ctx.scene, cacheFlag).length > 0);
    const assetReport = await runAssets(ctx.scene, {
      mode: assets,
      cacheDir: cacheFlag,
      maxDollars,
      image: needsLive ? new MuseImageProvider() : undefined,
      object: needsLive ? new Sam3dProvider() : undefined,
    });
    await writeDist(ctx, report, outDir, { startedAt: started, assets: assetReport, cacheDir: cacheFlag });
    return 0;
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

process.exit(await main());
