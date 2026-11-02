import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const TSX = pathToFileURL(createRequire(join(ENGINE, "package.json")).resolve("tsx")).href;

describe("B06: `check --report` without a value must not swallow the next flag", () => {
  it("rejects the missing value and creates no file named --built", () => {
    const cwd = mkdtempSync(join(tmpdir(), "b06-"));
    const dist = join(cwd, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "nav.json"), "{}");
    const scene = join(cwd, "scene.json");
    writeFileSync(scene, "{ not json");
    const r = spawnSync("node", ["--import", TSX, join(ENGINE, "bin/dreamer.ts"), "check", scene, "--report", "--built", dist], { cwd, encoding: "utf-8" });
    expect(existsSync(join(cwd, "--built"))).toBe(false);
    expect(r.status).toBe(2);
  });
});
