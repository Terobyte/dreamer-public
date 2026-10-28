#!/usr/bin/env node --import tsx
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { parseScene } from "../src/schema/parse.js";
import { emptyPassport, makeReport } from "../src/report/report.js";
import { runCheck } from "../src/check.js";
import { topSvg } from "../src/report/topsvg.js";

function main(): number {
  const args = process.argv.slice(2);
  if (args[0] !== "check" || !args[1]) {
    console.error("usage: dreamer check <scene> [--report <path>]");
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
    return report.ok ? 0 : 1;
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

process.exit(main());
