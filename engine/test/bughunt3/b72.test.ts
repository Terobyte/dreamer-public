import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const TSX = pathToFileURL(createRequire(join(ENGINE, "package.json")).resolve("tsx")).href;

describe("B72: clipfacts on a missing cast is a usage error", () => {
  it("exits 2 with a message, not an ENOENT stack trace", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "b72-")), "no-cast");
    const r = spawnSync("node", ["--import", TSX, join(ENGINE, "bin/dreamer.ts"), "clipfacts", missing], { encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no cast.json");
    expect(r.stderr).not.toContain("ENOENT");
  });
}, 90_000);
