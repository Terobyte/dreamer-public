import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAssets } from "../../src/assets/run.js";

describe("B35: runAssets drops refError assets from report.missing", () => {
  it("an object whose ref.image is missing is reported missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b35-"));
    const sceneDir = join(dir, "scene");
    mkdirSync(sceneDir);
    const scene: any = {
      assets: { chair: { kind: "object", prompt: "a chair", ref: { image: "missing.png", what: "chair" } } },
      props: [{ id: "p1", asset: "chair" }],
    };
    const report = await runAssets(scene, { mode: "cache", cacheDir: join(dir, "cache"), sceneDir });
    expect(report.fallback).toContain("chair");
    expect(report.failed?.[0]?.code).toBe("REF_MISSING");
    expect(report.missing).toContain("chair");
  });
});
