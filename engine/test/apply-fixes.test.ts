import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, applyFixes } from "../src/check.js";
import { patched } from "./helpers/scene.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));

/** the sofa backs onto the living room's west wall (inner face x = -3.94) */
function sofaAt(x: number): unknown {
  return patched([{ op: "replace", path: "/props/2/at", value: [x, 1.5] }]);
}

function build(scene: unknown, fix: boolean): { status: number | null; out: string; dist: string } {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
  const path = join(dir, "s.scene.json");
  writeFileSync(path, JSON.stringify(scene));
  const dist = join(dir, "dist");
  const args = ["--import", "tsx", "bin/dreamer.ts", "build", path, "--out", dist, "--assets", "none"];
  if (fix) args.push("--apply-fixes");
  const r = spawnSync("node", args, { cwd: ENGINE, encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr, dist };
}

/** F3: a wide prop against a circle wall: its corners meet the curve at other
 *  normals, so the travel to `fix.at` exceeds the penetration depth */
function arcScene(x: number): unknown {
  return patched([
    {
      op: "replace",
      path: "/rooms",
      value: [
        {
          id: "round",
          level: "L0",
          height: 3,
          circle: { c: [0, 0], r: 1.5 },
          floor: "parquet",
          ceiling: "white",
          walls: { material: "white" },
        },
      ],
    },
    { op: "replace", path: "/spawn", value: { room: "round", at: [-0.8, 0], yaw: 0 } },
    { op: "remove", path: "/openings" },
    { op: "remove", path: "/routes" },
    { op: "remove", path: "/decals" },
    { op: "remove", path: "/cameras" },
    {
      op: "replace",
      path: "/props",
      value: [
        {
          id: "bench",
          asset: "p_sofa",
          cat: "sofa",
          room: "round",
          at: [x, 0],
          size: { w: 2.0, d: 0.5, h: 0.5 },
          mount: "floor",
          face: "room",
          solid: true,
        },
      ],
    },
  ]);
}

describe("build --apply-fixes", () => {
  it("test_apply_fixes_small_wall_hit", () => {
    const scene = sofaAt(-3.52);
    const err = runCheck(scene).report.errors.find((e) => e.code === "PROP_HITS_WALL")!;
    expect(err.fix?.at).toBeDefined();
    const r = build(scene, true);
    expect(r.status, r.out).toBe(0);
    const b = JSON.parse(readFileSync(join(r.dist, "build.json"), "utf-8"));
    expect(b.props.sofa.at).toEqual(err.fix!.at);
    expect(r.out).toMatch(/WARN.*sofa/);
  }, 90000);

  it("test_apply_fixes_big_wall_hit_stays", () => {
    const r = build(sofaAt(-3.79), true);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("PROP_HITS_WALL");
  }, 90000);

  it("test_no_flag_no_fix", () => {
    const r = build(sofaAt(-3.52), false);
    expect(r.status).not.toBe(0);
  }, 90000);

  it("test_apply_fixes_limit_is_exact", () => {
    // F5: a hit a hair deeper than 0.1 m stays an error (no 1e-9 slack)
    const scene = sofaAt(-3.5900000005);
    const depth = (runCheck(scene).report.errors.find((e) => e.code === "PROP_HITS_WALL")?.data as { depth?: number }).depth!;
    expect(depth).toBeGreaterThan(0.1);
    expect(applyFixes(scene).report.errors.some((e) => e.code === "PROP_HITS_WALL")).toBe(true);
  });

  it("test_apply_fixes_arc_wall_depth", () => {
    const at: [number, number] = [0.908, 0];
    const scene = arcScene(at[0]);
    const err = runCheck(scene).report.errors.find((e) => e.code === "PROP_HITS_WALL")!;
    expect(err.fix?.at).toBeDefined();
    const depth = (err.data as { depth?: unknown } | undefined)?.depth;
    expect(typeof depth, JSON.stringify(err.msg)).toBe("number");
    const to = err.fix!.at as [number, number];
    const shift = Math.hypot(to[0] - at[0], to[1] - at[1]);
    // penetration within the limit, travel past it: the old shift-based gate refused this
    expect(depth as number).toBeLessThanOrEqual(0.1);
    expect(shift - 0.01).toBeGreaterThan(0.1);
    const r = build(scene, true);
    expect(r.status, r.out).toBe(0);
    const b = JSON.parse(readFileSync(join(r.dist, "build.json"), "utf-8"));
    // round3 may give -0 where JSON keeps 0: compare with tolerance
    const want = err.fix!.at as [number, number];
    expect(b.props.bench.at[0]).toBeCloseTo(want[0], 3);
    expect(b.props.bench.at[1]).toBeCloseTo(want[1], 3);
    expect(r.out).toMatch(/WARN.*bench/);
  }, 90000);
});
