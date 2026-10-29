import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";
import { floorAt, floorAtRooms } from "../src/nav/floor.js";
import { makeWalker } from "../src/runtime/walk.js";
import { demoFlat, patched } from "./helpers/scene.js";
import { caseScene } from "./helpers/broken.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";
const EXAMPLES = fileURLToPath(new URL("../../specs/examples/", import.meta.url));
const TSX_LOADER = createRequire(join(ENGINE, "package.json")).resolve("tsx");

function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", ...args], {
    cwd: ENGINE,
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dreamer-"));
}

describe("build cli", () => {
  let out: string;
  let before: string[];
  let run: { status: number; stdout: string; stderr: string };

  beforeAll(() => {
    before = readdirSync(EXAMPLES).sort();
    out = join(tmp(), "dist");
    run = cli(["build", DEMO, "--out", out, "--assets", "none", "--cache", tmp()]);
  }, 120000);

  it("test_build_cli_writes_dist", () => {
    expect([run.status, run.stderr]).toEqual([0, ""]);
    for (const f of ["index.html", "runtime.js", "geometry.json", "nav.json", "check.json", "top.svg", "build.json"]) {
      expect([f, existsSync(join(out, f))]).toEqual([f, true]);
    }
    expect(() => JSON.parse(readFileSync(join(out, "geometry.json"), "utf-8"))).not.toThrow();
    const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
    expect(build.ok).toBe(true);
    expect(build.assets.fallback.length).toBe(10);
  });

  it("test_build_refuses_bad_scene", () => {
    const scene = caseScene("broken", "PROP_HITS_WALL");
    const dir = tmp();
    const scenePath = join(dir, "bad.scene.json");
    writeFileSync(scenePath, JSON.stringify(scene));
    const dist = join(dir, "dist");
    const r = cli(["build", scenePath, "--out", dist, "--cache", tmp()]);
    expect(r.status).toBe(1);
    expect(existsSync(dist)).toBe(false);
    expect(r.stdout).toContain("PROP_HITS_WALL");
    const want = runCheck(scene as never).report.errors;
    expect(JSON.parse(r.stdout).errors).toEqual(want);
  }, 60000);

  it("test_build_ref_directory_falls_back", () => {
    const dir = tmp();
    const scene = patched([{ op: "add", path: "/cameras/0/ref", value: dir }]);
    const scenePath = join(dir, "demo-flat.scene.json");
    writeFileSync(scenePath, JSON.stringify(scene));
    const dist = join(dir, "dist");
    const r = cli(["build", scenePath, "--out", dist, "--assets", "none", "--cache", tmp()]);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    const build = JSON.parse(readFileSync(join(dist, "build.json"), "utf-8"));
    expect(build.ok).toBe(true);
    expect(build.warnings.some((w: string) => w.includes("door"))).toBe(true);
    const geometry = JSON.parse(readFileSync(join(dist, "geometry.json"), "utf-8"));
    expect(geometry.cameras[0].ref).toBe(null);
  });

  it("test_build_empty_ref_falls_back", () => {
    const dir = tmp();
    const scene = patched([{ op: "add", path: "/cameras/0/ref", value: "" }]);
    const scenePath = join(dir, "demo-flat.scene.json");
    writeFileSync(scenePath, JSON.stringify(scene));
    const dist = join(dir, "dist");
    const r = cli(["build", scenePath, "--out", dist, "--assets", "none", "--cache", tmp()]);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    const build = JSON.parse(readFileSync(join(dist, "build.json"), "utf-8"));
    expect(build.ok).toBe(true);
    expect(build.warnings.some((w: string) => w.includes("door"))).toBe(true);
    const geometry = JSON.parse(readFileSync(join(dist, "geometry.json"), "utf-8"));
    expect(geometry.cameras[0].ref).toBe(null);
  });

  it("test_build_rejects_flag_as_value", () => {
    const cwd = tmp();
    const beforeCwd = readdirSync(cwd).sort();
    const demoAbs = join(EXAMPLES, "demo-flat.scene.json");
    const binAbs = join(ENGINE, "bin/dreamer.ts");
    const r = spawnSync("node", ["--import", TSX_LOADER, binAbs, "build", demoAbs, "--out", "--assets", "none"], {
      cwd,
      encoding: "utf-8",
    });
    expect(r.status ?? -1).toBe(2);
    expect(readdirSync(cwd).sort()).toEqual(beforeCwd);
    expect(existsSync(join(cwd, "--assets"))).toBe(false);
  });

  it("test_build_no_side_effects", () => {
    expect(readdirSync(EXAMPLES).sort()).toEqual(before);
  });

  it("test_runtime_bundle_clean", () => {
    const js = readFileSync(join(out, "runtime.js"), "utf-8");
    expect(js).not.toContain("clipper2");
    expect(js).not.toContain("Buffer.from");
  });

  it("test_floor_at_rooms", () => {
    const ctx = runCheck(demoFlat()).ctx;
    const geo = buildGeometry(ctx);
    const pts: Array<[number, number]> = [
      [-1, 10],
      [0, 4],
      [0, 0.5],
      [-3.45, 1.5],
      [10, 10],
    ];
    const want = [0, 0, 0, 0, null];
    pts.forEach((p, i) => {
      const a = floorAtRooms(geo.floors, p[0], p[1], 0);
      expect([i, a]).toEqual([i, floorAt(ctx, p[0], p[1], 0)]);
      expect([i, a]).toEqual([i, want[i]]);
    });
  });

  it("test_rebuild_under_10s", () => {
    const r = cli(["build", DEMO, "--out", out, "--assets", "none", "--cache", tmp()]);
    expect(r.status).toBe(0);
    const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
    expect(build.seconds).toBeLessThan(10);
  }, 60000);

  it("test_walker_starts_on_spawn_floor", () => {
    const walker = makeWalker(
      { level: "L0", y: 3.6, origin: [-1, -1], w: 50, h: 50 },
      new Uint8Array(400).fill(255),
      [{ y: 3.6, outline: [[-1, -1], [1, -1], [1, 1], [-1, 1]] }],
      [0, 0],
    );
    expect(walker.pos()).toEqual([0, 5.2, 0]);
    expect(() => walker.teleport(0, 0)).not.toThrow();
  });

  it("test_mesh_count_ignores_id_collisions", () => {
    const scene = patched([{ op: "replace", path: "/props/2/id", value: "cap:0" }]);
    const ctx = runCheck(scene as never).ctx;
    const geo = buildGeometry(ctx);
    // ids collide (a generated wall cap also gets "cap:0"), but every mesh
    // in `geometry.meshes` must still be counted
    expect(new Set(geo.meshes.map((m) => m.id)).size).toBeLessThan(geo.meshes.length);
  });

  it("test_fallback_excludes_unused_assets", () => {
    const dir = tmp();
    const scenePath = join(dir, "unused-asset.scene.json");
    const scene = patched([
      { op: "add", path: "/assets/p_unused", value: { kind: "object", prompt: "an unused prop asset" } },
    ]) as any;
    writeFileSync(scenePath, JSON.stringify(scene));
    const dist = join(dir, "dist");
    const r = cli(["build", scenePath, "--out", dist, "--assets", "none", "--cache", tmp()]);
    expect(r.status).toBe(0);
    const build = JSON.parse(readFileSync(join(dist, "build.json"), "utf-8"));
    expect(build.assets.fallback).not.toContain("p_unused");
  }, 60000);
});
