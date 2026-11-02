import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("B06 --report missing value must not swallow --built", () => {
  it("dreamer check scene.json --report --built dist errors instead of creating file named --built", () => {
    const dir = mkdtempSync(join(tmpdir(), "b06-"));
    const scene = join(dir, "scene.json");
    writeFileSync(scene, JSON.stringify({ name: "t", rooms: [] }));
    const dist = join(dir, "dist");
    // run from temp dir so a stray file named `--built` would land there
    let code = 0;
    let stderr = "";
    try {
      execFileSync("npx", ["tsx", "engine/bin/dreamer.ts", "check", scene, "--report", "--built", dist], {
        cwd: dir,
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (e: any) {
      code = e.status ?? 2;
      stderr = String(e.stderr ?? e.message ?? "");
    }
    const stray = join(dir, "--built");
    const strayExists = existsSync(stray);
    // expected: CLI usage error about missing --report value (exit 2), no file named --built
    expect(`${code} ${stderr} stray=${strayExists} files=${JSON.stringify(readdirSync(dir))}`).toContain("stray=false");
    expect(code).toBe(2);
  });
});
