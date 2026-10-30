import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoFlat, patched } from "./helpers/scene.js";
import { fakePng } from "../src/assets/providers/fake.js";
import { sheetHtml, SHOTS_DEFAULTS } from "../src/build/shots.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));

function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", ...args], { cwd: ENGINE, encoding: "utf-8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** build a scene into a fresh dist/, with fake shots for every camera */
function built(scene: unknown, withRef: boolean): { dir: string; dist: string; scenePath: string; ids: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-d1-"));
  const scenePath = join(dir, "demo-flat.scene.json");
  if (withRef) writeFileSync(join(dir, "myref.png"), fakePng(8, 8, [10, 20, 30]));
  writeFileSync(scenePath, JSON.stringify(scene));
  const dist = join(dir, "dist");
  const r = cli(["build", scenePath, "--out", dist, "--assets", "none", "--cache", mkdtempSync(join(tmpdir(), "c-"))]);
  expect([r.status, r.stderr]).toEqual([0, ""]);
  const ids = (JSON.parse(readFileSync(join(dist, "geometry.json"), "utf-8")).cameras as { id: string }[]).map((c) => c.id);
  mkdirSync(join(dist, "shots"), { recursive: true });
  for (const id of ids) writeFileSync(join(dist, "shots", `${id}.png`), fakePng(8, 8, [1, 2, 3]));
  return { dir, dist, scenePath, ids };
}

describe("D1 camera refs", () => {
  it("test_build_copies_ref_next_to_shot", () => {
    const scene = patched([{ op: "add", path: "/cameras/0/ref", value: "myref.png" }]);
    const { dist, ids } = built(scene, true);
    expect(existsSync(join(dist, "shots", `${ids[0]}.ref.png`))).toBe(true);
  }, 120000);

  it("test_sheet_pairs_ref_and_shot_in_one_row", () => {
    const html = sheetHtml([{ id: "a", ref: "refs/0-a.png" }, { id: "b" }], SHOTS_DEFAULTS);
    const row = html.split('<div class="row">').find((r) => r.includes("refs/0-a.png"))!;
    expect(row).toContain("shots/a.png");
    expect(html).toContain("1 из 2 камер с референсом");
    expect(html.indexOf("shots/b.png")).toBeGreaterThan(html.indexOf("shots/a.png"));
  });

  it("test_check_built_shot_missing", () => {
    const { dist, scenePath, ids } = built(patched([{ op: "add", path: "/cameras/0/ref", value: "myref.png" }]), true);
    rmSync(join(dist, "shots", `${ids[0]}.png`));
    const r = cli(["check", scenePath, "--built", dist, "--report", join(dist, "r.json")]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("SHOT_MISSING");
  }, 120000);

  it("test_check_built_camera_no_ref_warns", () => {
    const { dist, scenePath } = built(demoFlat(), false);
    const r = cli(["check", scenePath, "--built", dist, "--report", join(dist, "r.json")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CAMERA_NO_REF");
    expect(JSON.parse(r.stdout).warnings.some((w: { code: string }) => w.code === "CAMERA_NO_REF")).toBe(true);
  }, 120000);

  it("test_check_built_shots_dir_missing", () => {
    const { dist, scenePath } = built(patched([{ op: "add", path: "/cameras/0/ref", value: "myref.png" }]), true);
    rmSync(join(dist, "shots"), { recursive: true, force: true });
    const r = cli(["check", scenePath, "--built", dist, "--report", join(dist, "r.json")]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("SHOT_MISSING");
  }, 120000);

  it("test_check_built_missing_ref_file_warns", () => {
    const { dist, scenePath } = built(patched([{ op: "add", path: "/cameras/0/ref", value: "missing.png" }]), false);
    const r = cli(["check", scenePath, "--built", dist, "--report", join(dist, "r.json")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CAMERA_NO_REF");
  }, 120000);

  it("test_check_built_no_geometry_reports_missing", () => {
    const { dist, scenePath, ids } = built(patched([{ op: "add", path: "/cameras/0/ref", value: "myref.png" }]), true);
    rmSync(join(dist, "geometry.json"));
    const r = cli(["check", scenePath, "--built", dist, "--report", join(dist, "r.json")]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("SHOT_MISSING");
    for (const id of ids) expect(r.stdout).toContain(id);
  }, 120000);

  it("test_check_built_shot_dir_is_missing", () => {
    const { dist, scenePath, ids } = built(patched([{ op: "add", path: "/cameras/0/ref", value: "myref.png" }]), true);
    rmSync(join(dist, "shots", `${ids[0]}.png`));
    mkdirSync(join(dist, "shots", `${ids[0]}.png`), { recursive: true });
    const r = cli(["check", scenePath, "--built", dist, "--report", join(dist, "r.json")]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("SHOT_MISSING");
  }, 120000);
});
