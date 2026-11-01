import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

function run(args: string[]) {
  return spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", ...args], { cwd: ENGINE, encoding: "utf-8" });
}

describe("check --built missing GLB", () => {
  it("fails with the prop id when an object asset has no cached GLB", () => {
    const tmp = mkdtempSync(join(tmpdir(), "dreamer-"));
    const dist = join(tmp, "dist");
    mkdirSync(join(tmp, "cache"));
    const b = run(["build", DEMO, "--out", dist, "--assets", "cache", "--cache", join(tmp, "cache")]);
    expect(b.status).toBe(0);
    mkdirSync(join(dist, "shots"), { recursive: true });
    writeFileSync(join(dist, "shots", "door.png"), "");
    const report = join(tmp, "report.json");
    const c = run(["check", DEMO, "--report", report, "--built", dist]);
    expect(c.status).not.toBe(0);
    const issues = JSON.parse(readFileSync(report, "utf-8"));
    const hits = JSON.stringify(issues);
    expect(hits).toContain("ASSET_MISSING");
    expect(hits).toContain("/props/table");
    expect(hits).not.toContain("/props/p_table");
  }, 90000);
});
