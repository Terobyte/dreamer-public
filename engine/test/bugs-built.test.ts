import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sheetHtml, SHOTS_DEFAULTS } from "../src/build/shots.js";
import { demoFlat } from "./helpers/scene.js";
import { fakeShots } from "./fake-shots.js";

const ENGINE = fileURLToPath(new URL("../", import.meta.url));
const cli = (args: string[]) => spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", ...args], { cwd: ENGINE, encoding: "utf-8" });

describe("built regressions", () => {
  it("test_B19_check_built_uses_scene_cameras_not_stale_dist", () => {
    const root = mkdtempSync(join(tmpdir(), "dreamer-B19-"));
    const scenePath = join(root, "scene.json");
    const dist = join(root, "dist");
    const first = demoFlat() as any;
    first.cameras = [{ ...first.cameras[0], id: "a" }];
    writeFileSync(scenePath, JSON.stringify(first));
    const built = cli(["build", scenePath, "--out", dist, "--assets", "none"]);
    expect([built.status, built.stdout, built.stderr]).toEqual([0, "", ""]);
    fakeShots(dist);

    // the scene now has only camera "b"; the old dist (camera "a") is checked without a rebuild
    const second = JSON.parse(readFileSync(scenePath, "utf-8")) as any;
    second.cameras = [{ ...second.cameras[0], id: "b" }];
    writeFileSync(scenePath, JSON.stringify(second));

    const result = cli(["check", scenePath, "--built", dist, "--report", join(root, "report.json")]);
    expect(result.stdout).toMatch(/SHOT_MISSING[^\n]*\bb\b/);
  }, 120000);

  it("test_B37_shot_names_are_unique_case_insensitively", () => {
    const html = sheetHtml([{ id: "A" }, { id: "a" }], SHOTS_DEFAULTS);
    const files = [...html.matchAll(/class="pane" src="(shots\/[^\"]+)"/g)].map((m) => m[1]!.toLowerCase());
    expect(new Set(files).size).toBe(2);
  });

  it("test_B37_shot_names_are_unique_across_unicode_forms", () => {
    // APFS also folds NFC/NFD: precomposed é and e + combining acute are one file
    const html = sheetHtml([{ id: "é" }, { id: "é" }], SHOTS_DEFAULTS);
    const files = [...html.matchAll(/class="pane" src="(shots\/[^\"]+)"/g)]
      .map((m) => decodeURIComponent(m[1]!).normalize("NFC").toLowerCase());
    expect(new Set(files).size).toBe(2);
  });
});
