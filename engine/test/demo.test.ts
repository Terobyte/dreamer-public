import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/check.js";
import { CODES } from "../src/report/codes.js";
import type { Code, Report } from "../src/types.js";
import { demoFlat } from "./helpers/scene.js";
import { caseNames, runCase } from "./helpers/broken.js";

const goldenUrl = new URL("./golden/demo-flat.check.json", import.meta.url);

// phase 1 does not emit these, so no case scene can exist for them;
// budget codes only fire with `--built` tris from a dist/, which runCase never passes;
// ASSET_FAILED only comes from the asset step of `build`, never from `check`;
// ASSET_MISSING only fires with `--built` assets.missing from a dist/, which runCase never passes
const OUT_OF_PHASE = new Set<Code>([
  "ASSET_FAILED",
  "ASSET_MISSING",
  "STAIR_EXIT_OUTSIDE",
  "STAIR_HEADROOM",
  "ROUTE_BLOCKED",
  "TRI_PROP_BUDGET",
  "TRI_SCENE_BUDGET",
  "POINT_LIGHT_BUDGET",
  "SHOT_MISSING",
  "CAMERA_NO_REF",
]);

function codesOfLevel(level: "error" | "warn"): string[] {
  return (Object.keys(CODES) as Code[])
    .filter((c) => CODES[c].level === level && !OUT_OF_PHASE.has(c))
    .sort();
}

describe("demo-flat", () => {
  let report: Report;

  beforeAll(() => {
    report = runCheck(demoFlat()).report;
  });

  it("test_demo_flat_full", () => {
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.ok).toBe(true);
    for (const s of report.stages) {
      expect([s.stage, s.status]).toEqual([s.stage, s.stage === "stairs" ? "skipped" : "pass"]);
    }

    const actual = JSON.stringify(report, null, 2);
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(fileURLToPath(goldenUrl), `${actual}\n`);
    }
    expect(existsSync(fileURLToPath(goldenUrl))).toBe(true);
    expect(JSON.parse(actual)).toEqual(JSON.parse(readFileSync(goldenUrl, "utf-8")));
  });

  it("test_broken_one_code_each", () => {
    expect(caseNames("broken")).toEqual(codesOfLevel("error"));
    for (const name of caseNames("broken")) {
      const r = runCase("broken", name);
      expect([name, r.errors.map((e) => e.code)]).toEqual([name, [name]]);
      expect([name, r.warnings]).toEqual([name, []]);
    }

    expect(caseNames("warn")).toEqual(codesOfLevel("warn"));
    for (const name of caseNames("warn")) {
      const r = runCase("warn", name);
      expect([name, r.errors]).toEqual([name, []]);
      expect([name, r.warnings.map((w) => w.code)]).toEqual([name, [name]]);
    }
  });
});
