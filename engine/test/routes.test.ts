import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoute, gridOf, walkable, cellOf } from "../src/routes/astar.js";
import { CELL } from "../src/nav/floor.js";
import { demoFlat, patched } from "./helpers/scene.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

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

/** stdout is the pretty report, then the `исправлено:` / `появилось:` lines. */
function reportOf(stdout: string): any {
  const lines = stdout.split("\n");
  const end = lines.indexOf("}");
  return JSON.parse(lines.slice(0, end + 1).join("\n"));
}

/** Write a scene object next to a fresh report path and check it with `--built`. */
function buildAndCheck(scene: unknown, extra: string[] = []): any {
  const dir = tmp();
  const scenePath = join(dir, "s.scene.json");
  writeFileSync(scenePath, JSON.stringify(scene));
  const out = join(dir, "dist");
  const b = cli(["build", scenePath, "--out", out, "--assets", "none", "--cache", tmp()]);
  expect([b.status, b.stderr]).toEqual([0, ""]);
  const report = join(dir, "r.json");
  const c = cli(["check", scenePath, "--report", report, "--built", out, ...extra]);
  expect(c.stderr).toBe("");
  return { ...JSON.parse(readFileSync(report, "utf-8")), stdout: c.stdout, status: c.status, dist: out };
}

describe("routes stage", () => {
  it("test_route_in_passes", () => {
    const dir = tmp();
    const out = join(dir, "dist");
    const b = cli(["build", DEMO, "--out", out, "--assets", "none", "--cache", tmp()]);
    expect([b.status, b.stderr]).toEqual([0, ""]);
    const report = join(dir, "r.json");
    const c = cli(["check", DEMO, "--report", report, "--built", out]);
    expect([c.status, c.stderr]).toEqual([0, ""]);
    const r = JSON.parse(readFileSync(report, "utf-8"));
    expect(r.ok).toBe(true);
    expect(r.errors.filter((e: any) => e.code === "ROUTE_BLOCKED")).toEqual([]);
    expect(r.stages.at(-1)).toEqual({ stage: "routes", status: "pass" });
  }, 120000);

  it("test_route_no_built_no_stage", () => {
    const dir = tmp();
    const report = join(dir, "r.json");
    const c = cli(["check", DEMO, "--report", report]);
    expect([c.status, c.stderr]).toEqual([0, ""]);
    const r = JSON.parse(readFileSync(report, "utf-8"));
    expect(r.stages.some((s: any) => s.stage === "routes")).toBe(false);
  }, 120000);

  it("test_route_built_missing_nav", () => {
    const dir = tmp();
    const c = cli(["check", DEMO, "--report", join(dir, "r.json"), "--built", tmp()]);
    expect(c.status).toBe(2);
    expect(c.stderr).toContain("built: nav.json not found");
  }, 60000);

  it("test_route_built_missing_nav_malformed_scene", () => {
    const dir = tmp();
    const scene = join(dir, "bad.scene.json");
    writeFileSync(scene, "{ not json");
    const c = cli(["check", scene, "--report", join(dir, "r.json"), "--built", tmp()]);
    expect(c.status).toBe(2);
    expect(c.stderr).toContain("built: nav.json not found");
  }, 60000);

  it("test_route_blocked_by_closed_door", () => {
    const scene = patched([{ op: "replace", path: "/openings/0/leaf/open", value: false }]);
    const r = buildAndCheck(scene);
    const blocked = r.errors.filter((e: any) => e.code === "ROUTE_BLOCKED");
    expect(blocked.length).toBe(1);
    expect(blocked[0].stage).toBe("routes");
    expect(blocked[0].path).toBe("/routes/0/path/1");
    expect(blocked[0].msg).toContain("закрытая дверь front");
    const m = /застрял в \(([-\d.]+), ([-\d.]+)\)/.exec(blocked[0].msg);
    expect(m).not.toBeNull();
    const z = Number(m![2]);
    expect(z).toBeGreaterThanOrEqual(4.3);
    expect(z).toBeLessThanOrEqual(4.6);
  }, 120000);

  it("test_route_blocked_by_wall", () => {
    const scene = patched([
      { op: "replace", path: "/openings/0/leaf/open", value: false },
      {
        op: "replace",
        path: "/routes",
        value: [{ id: "x", path: ["spawn", { room: "living", at: [3.5, 3.5] }] }],
      },
    ]);
    const r = buildAndCheck(scene);
    const blocked = r.errors.filter((e: any) => e.code === "ROUTE_BLOCKED");
    expect(blocked.length).toBe(1);
    expect(blocked[0].msg).toContain("x:");
    expect(blocked[0].msg).toContain("(1.66, 4.34)");
    expect(blocked[0].msg).not.toContain("закрытая дверь");
  }, 120000);

  it("test_route_blocked_first_point_unreachable", () => {
    const scene = patched([
      {
        op: "replace",
        path: "/routes",
        value: [{ id: "x", path: [{ room: "living", at: [100, 100] }, "spawn"] }],
      },
    ]);
    const r = buildAndCheck(scene);
    const blocked = r.errors.filter((e: any) => e.code === "ROUTE_BLOCKED");
    expect(blocked.length).toBe(1);
    expect(blocked[0].path).toBe("/routes/0/path/0");
    const m = /застрял в \(([-\d.]+), ([-\d.]+)\)/.exec(blocked[0].msg);
    expect(m).not.toBeNull();
    const x = Number(m![1]);
    const z = Number(m![2]);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(z)).toBe(true);
    // the stuck point must be a real, walkable cell of the built nav grid,
    // not just "somewhere less than 50" (which (100, 100) itself satisfies)
    const nav = JSON.parse(readFileSync(join(r.dist, "nav.json"), "utf-8"));
    const g = gridOf(nav, "L0")!;
    const [i, j] = cellOf(g, [x, z]);
    expect(walkable(g, i, j)).toBe(true);
    expect(x).toBeCloseTo(g.origin[0] + (i + 0.5) * CELL, 6);
    expect(z).toBeCloseTo(g.origin[1] + (j + 0.5) * CELL, 6);
  }, 120000);

  it("test_route_unknown_target", () => {
    const scene = patched([
      { op: "replace", path: "/routes", value: [{ id: "x", path: ["spawn", "missing-opening"] }] },
    ]);
    const r = buildAndCheck(scene);
    expect(r.ok).toBe(false);
    const unk = r.errors.filter((e: any) => e.code === "REF_UNKNOWN" && e.path === "/routes/0/path/1");
    expect(unk.length).toBe(1);
    expect(unk[0].stage).toBe("routes");
  }, 120000);

  it("test_schema_fail_with_built_skips_routes", () => {
    const dir = tmp();
    const out = join(dir, "dist");
    const b = cli(["build", DEMO, "--out", out, "--assets", "none", "--cache", tmp()]);
    expect([b.status, b.stderr]).toEqual([0, ""]);
    const scene = patched([{ op: "add", path: "/rooms/0/bogus_field", value: 1 }]);
    const dir2 = tmp();
    const scenePath = join(dir2, "s.scene.json");
    writeFileSync(scenePath, JSON.stringify(scene));
    const report = join(dir2, "r.json");
    const c = cli(["check", scenePath, "--report", report, "--built", out]);
    expect(c.status).toBe(1);
    const r = JSON.parse(readFileSync(report, "utf-8"));
    expect(r.stages.at(-1)).toEqual({ stage: "routes", status: "skipped" });
  }, 120000);

  it("test_find_route_unit", () => {
    const w = 10;
    const h = 10;
    const pack = (hole: boolean): string => {
      const bytes = Buffer.alloc(Math.ceil((w * h) / 8));
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if (i === 5 && !(hole && j === 5)) continue;
          const n = j * w + i;
          bytes[n >> 3] |= 1 << (n & 7);
        }
      }
      return bytes.toString("base64");
    };
    const nav = (hole: boolean): any => ({
      cell: CELL,
      capsule: { r: 0.25, h: 1.8, step_max: 0.25 },
      layers: [{ level: "L0", y: 0, origin: [0, 0], w, h, bits: pack(hole) }],
      ramps: [],
      links: [],
    });
    const ctr = (i: number, j: number): [number, number] => [(i + 0.5) * CELL, (j + 0.5) * CELL];
    const from = ctr(1, 5);
    const to = ctr(8, 5);

    const bad = findRoute(nav(false), from, to, "L0");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Math.floor(bad.stuck[0] / CELL + 1e-9)).toBe(4);
    }

    const good = findRoute(nav(true), from, to, "L0");
    expect(good.ok).toBe(true);
    if (good.ok) {
      const cell = (p: [number, number]): [number, number] => [
        Math.floor(p[0] / CELL + 1e-9),
        Math.floor(p[1] / CELL + 1e-9),
      ];
      expect(cell(good.path[0])).toEqual([1, 5]);
      expect(cell(good.path.at(-1)!)).toEqual([8, 5]);
    }
  });
});

describe("report diff", () => {
  let dir: string;
  let scenePath: string;
  let report: string;
  let first: { stdout: string };
  let second: { stdout: string };

  beforeAll(() => {
    dir = tmp();
    scenePath = join(dir, "s.scene.json");
    report = join(dir, "r.json");
    const ops = JSON.parse(
      readFileSync(new URL("./scenes/broken/PROP_HITS_WALL.patch.json", import.meta.url), "utf-8"),
    );
    writeFileSync(scenePath, JSON.stringify(patched(ops)));
    first = cli(["check", scenePath, "--report", report]);
    writeFileSync(scenePath, JSON.stringify(demoFlat()));
    second = cli(["check", scenePath, "--report", report]);
  }, 120000);

  it("test_report_no_diff_first_time", () => {
    expect(reportOf(first.stdout)).not.toHaveProperty("diff");
  });

  it("test_report_diff_new_and_fixed", () => {
    const r = reportOf(second.stdout);
    expect(r.diff.new).toEqual([]);
    expect(r.diff.fixed.length).toBe(1);
    expect(r.diff.fixed[0].code).toBe("PROP_HITS_WALL");
    expect(second.stdout).toContain("исправлено: PROP_HITS_WALL /props/");
  });

  it("test_report_diff_same", () => {
    const d = tmp();
    const sp = join(d, "s.scene.json");
    const rp = join(d, "r.json");
    const ops = JSON.parse(
      readFileSync(new URL("./scenes/broken/PROP_HITS_WALL.patch.json", import.meta.url), "utf-8"),
    );
    writeFileSync(sp, JSON.stringify(patched(ops)));
    cli(["check", sp, "--report", rp]);
    const again = cli(["check", sp, "--report", rp]);
    expect(reportOf(again.stdout).diff).toEqual({ fixed: [], new: [] });
  }, 120000);

  it("test_report_diff_on_parse_fail", () => {
    const d = tmp();
    const sp = join(d, "s.scene.json");
    const rp = join(d, "r.json");
    writeFileSync(sp, JSON.stringify(demoFlat()));
    cli(["check", sp, "--report", rp]);
    writeFileSync(sp, "{ broken json ,,, ");
    const second = cli(["check", sp, "--report", rp]);
    const r = reportOf(second.stdout);
    expect(r.diff.new.some((i: any) => i.code === "SCHEMA_PARSE")).toBe(true);
    expect(second.stdout).toContain("появилось: SCHEMA_PARSE");
  }, 120000);
});
