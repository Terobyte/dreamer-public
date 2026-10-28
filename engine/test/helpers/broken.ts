import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCheck } from "../../src/check.js";
import { parseScene } from "../../src/schema/parse.js";
import { emptyPassport, makeReport, STAGES } from "../../src/report/report.js";
import type { Report } from "../../src/types.js";
import { patched } from "./scene.js";

const dirs = {
  broken: new URL("../scenes/broken/", import.meta.url),
  warn: new URL("../scenes/warn/", import.meta.url),
};

export function caseNames(kind: "broken" | "warn"): string[] {
  return readdirSync(fileURLToPath(dirs[kind]))
    .map((f) => f.replace(/\.(patch|scene)\.json$/, ""))
    .sort();
}

/** The scene a case describes, or null when it is raw text that must not parse. */
export function caseScene(kind: "broken" | "warn", name: string): any {
  const files = readdirSync(fileURLToPath(dirs[kind]));
  if (files.includes(`${name}.scene.json`)) {
    const text = readFileSync(new URL(`${name}.scene.json`, dirs[kind]), "utf-8");
    return parseScene(text).raw;
  }
  const ops = JSON.parse(readFileSync(new URL(`${name}.patch.json`, dirs[kind]), "utf-8"));
  return patched(ops);
}

/** Run one case scene: a JSON Patch over demo-flat, or raw text for SCHEMA_PARSE. */
export function runCase(kind: "broken" | "warn", name: string): Report {
  const files = readdirSync(fileURLToPath(dirs[kind]));
  if (files.includes(`${name}.scene.json`)) {
    const text = readFileSync(new URL(`${name}.scene.json`, dirs[kind]), "utf-8");
    const { raw, issues } = parseScene(text);
    if (raw === null) {
      const stages = STAGES.map((s, i) => ({
        stage: s,
        status: (i === 0 ? "fail" : "skipped") as "fail" | "skipped",
      }));
      return makeReport(stages, emptyPassport(), issues, []);
    }
    return runCheck(raw).report;
  }
  const ops = JSON.parse(readFileSync(new URL(`${name}.patch.json`, dirs[kind]), "utf-8"));
  return runCheck(patched(ops)).report;
}
