import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";
import { buildNav } from "../src/nav/grid.js";
import { floorAtRooms, navBit, type NavLayer, type NavRamp } from "../src/nav/floor.js";
import { findRouteLevels } from "../src/routes/astar.js";
import type { NavJson } from "../src/types.js";

/** Packs a w*h grid of 0/1 into the base64 bitset `NavJson` layers use. */
function packGrid(w: number, h: number, walkable: (i: number, j: number) => boolean): string {
  const bytes = new Uint8Array(Math.ceil((w * h) / 8));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!walkable(i, j)) continue;
      const n = j * w + i;
      bytes[n >> 3] |= 1 << (n & 7);
    }
  }
  return Buffer.from(bytes).toString("base64");
}

const ENGINE = fileURLToPath(new URL("../", import.meta.url));
const demoUrl = new URL("../../specs/examples/demo.scene.json", import.meta.url);

function demo(): any {
  return JSON.parse(readFileSync(demoUrl, "utf-8"));
}

function layerOf(nav: NavJson, level: string): { layer: NavLayer; bits: Uint8Array } {
  const layer = (nav.layers as NavLayer[]).find((l) => l.level === level);
  expect(layer, `layer ${level}`).toBeDefined();
  return { layer: layer!, bits: new Uint8Array(Buffer.from(String(layer!.bits), "base64")) };
}

describe("stairs nav", () => {
  let nav: NavJson;
  let floors: Array<{ y: number; outline: [number, number][] }>;

  beforeAll(() => {
    const { report, ctx } = runCheck(demo());
    expect(report.errors).toEqual([]);
    nav = buildNav(ctx);
    floors = buildGeometry(ctx).floors.map((f) => ({ y: f.y, outline: f.outline as [number, number][] }));
  });

  it("test_nav_ramp_and_link", () => {
    const ramps = nav.ramps as NavRamp[];
    expect(ramps).toHaveLength(1);
    const r = ramps[0];
    expect(r.stair).toBe("up");
    expect(r.y0).toBeCloseTo(0, 6);
    expect(r.y1).toBeCloseTo(3.6, 6);
    expect(r.axis.from[0]).toBeCloseTo(1.4, 6);
    expect(r.axis.from[1]).toBeCloseTo(11.6, 6);
    expect(r.axis.dir).toBeCloseTo(180, 6);
    expect(r.axis.len).toBeCloseTo(5.6, 6);
    expect(r.poly).toHaveLength(4);
    const xs = r.poly.map((p) => p[0]);
    const zs = r.poly.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0.95, 6);
    expect(Math.max(...xs)).toBeCloseTo(1.85, 6);
    expect(Math.min(...zs)).toBeCloseTo(6.0, 6);
    expect(Math.max(...zs)).toBeCloseTo(11.6, 6);

    expect(nav.links).toEqual([{ from: "L0", to: "L1", via: "up" }]);
    expect((nav.layers as NavLayer[]).map((l) => l.level)).toEqual(["L0", "L1"]);
  });

  it("test_floor_at_ramp", () => {
    const ramps = nav.ramps as NavRamp[];
    expect(floorAtRooms(floors, 1.4, 8.8, 1.7, ramps)).toBeCloseTo(1.8, 6);
    // the [yPrev - 0.5, yPrev + STEP_MAX] window holds on a ramp too
    expect(floorAtRooms(floors, 1.4, 8.8, 0.5, ramps)).toBe(null);
    expect(floorAtRooms(floors, 1.4, 8.8, 3.0, ramps)).toBe(null);
  });

  it("test_l1_exit_walkable", () => {
    const l1 = layerOf(nav, "L1");
    expect(navBit(l1.layer, l1.bits, 1.4, 5.9)).toBe(true);
    const l0 = layerOf(nav, "L0");
    expect(navBit(l0.layer, l0.bits, 1.4, 11.6)).toBe(true);
    expect(navBit(l0.layer, l0.bits, 1.4, 11.65)).toBe(true);
  });

  it("test_route_upstairs", () => {
    const plain = runCheck(demo());
    expect(plain.report.warnings).toEqual([]);

    const dist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
    const r = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "bin/dreamer.ts",
        "build",
        fileURLToPath(demoUrl),
        "--out",
        dist,
        "--assets",
        "none",
        "--cache",
        mkdtempSync(join(tmpdir(), "dreamer-cache-")),
      ],
      { cwd: ENGINE, encoding: "utf-8" },
    );
    expect(r.status, r.stderr).toBe(0);

    const builtNav = JSON.parse(readFileSync(join(dist, "nav.json"), "utf-8")) as NavJson;
    const built = runCheck(demo(), { builtNav });
    expect(built.report.errors).toEqual([]);
    expect(built.report.warnings).toEqual([]);
  });

  it("test_flood_crosses_link_downward", () => {
    const scene = demo();
    scene.spawn = { room: "loft", at: [-1, 5], yaw: 0 };
    const { report } = runCheck(scene);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("test_route_downlink_skips_blocked_foot_cell", () => {
    // Synthetic two-layer nav: the ramp foot's exact cell is blocked, but the
    // first cell past it (away from the ramp) is walkable -- same as the nav
    // flood's own landing search (grid.ts footSeedCell). A route down from
    // the upper layer must not be refused just because the foot cell itself
    // is solid.
    const w = 20;
    const h = 5;
    const footBlocked: [number, number] = [10, 2]; // cell under axis.from = [0.4, 0.1]
    const lo: NavLayer = {
      level: "L0",
      y: 0,
      origin: [0, 0],
      w,
      h,
      bits: packGrid(w, h, (i, j) => !(i === footBlocked[0] && j === footBlocked[1])),
    } as unknown as NavLayer;
    const hi: NavLayer = {
      level: "L1",
      y: 1,
      origin: [0, 0.5],
      w,
      h,
      bits: packGrid(w, h, () => true),
    } as unknown as NavLayer;
    const ramp = {
      stair: "up",
      y0: 0,
      y1: 1,
      axis: { from: [0.4, 0.1] as [number, number], dir: 0, len: 0.4 },
      poly: [
        [0.2, 0.1],
        [0.6, 0.1],
        [0.6, 0.5],
        [0.2, 0.5],
      ] as [number, number][],
    };
    const synthNav = {
      cell: 0.04,
      capsule: { r: 0.25, h: 1.6, step_max: 0.25 },
      layers: [lo, hi],
      ramps: [ramp],
      links: [{ from: "L0", to: "L1", via: "up" }],
    } as unknown as NavJson;

    const result = findRouteLevels(synthNav, { level: "L1", at: [0.4, 0.6] }, { level: "L0", at: [0.4, 0.02] });
    expect(result.ok).toBe(true);
  });

  it("test_route_stuck_nearest_when_level_unreachable", () => {
    // Two walkable layers with no link between them: the target layer can
    // never be reached, so `stuck` has to be the reachable cell nearest the
    // target in plan, not whichever cell A* happened to pop last.
    const w = 20;
    const h = 5;
    const layer = (level: string, y: number): NavLayer =>
      ({ level, y, origin: [0, 0], w, h, bits: packGrid(w, h, () => true) }) as unknown as NavLayer;
    const synthNav = {
      cell: 0.04,
      capsule: { r: 0.25, h: 1.6, step_max: 0.25 },
      layers: [layer("L0", 0), layer("L1", 1)],
      ramps: [],
      links: [],
    } as unknown as NavJson;

    const result = findRouteLevels(synthNav, { level: "L0", at: [0.02, 0.02] }, { level: "L1", at: [0.62, 0.02] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stuck.level).toBe("L0");
    expect(result.stuck.at[0]).toBeCloseTo(0.62, 6);
    expect(result.stuck.at[1]).toBeCloseTo(0.02, 6);
  });

  it("test_route_stuck_tie_is_order_free", () => {
    // The target sits exactly between two L0 cells (x 0.38 and 0.42) of an
    // unreachable layer. Searched from the left or from the right, A* pops
    // those two in opposite order; the stuck cell must still be the same one
    // -- the smaller cell key -- not whichever came first.
    const w = 20;
    const h = 5;
    const layer = (level: string, y: number): NavLayer =>
      ({ level, y, origin: [0, 0], w, h, bits: packGrid(w, h, () => true) }) as unknown as NavLayer;
    const synthNav = {
      cell: 0.04,
      capsule: { r: 0.25, h: 1.6, step_max: 0.25 },
      layers: [layer("L0", 0), layer("L1", 1)],
      ramps: [],
      links: [],
    } as unknown as NavJson;

    for (const start of [[0.02, 0.1], [0.78, 0.1]] as [number, number][]) {
      const result = findRouteLevels(synthNav, { level: "L0", at: start }, { level: "L1", at: [0.4, 0.1] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stuck.level).toBe("L0");
      expect(result.stuck.at[0], `from ${start}`).toBeCloseTo(0.38, 6);
      expect(result.stuck.at[1]).toBeCloseTo(0.1, 6);
    }
  });

  it("test_floor_at_stacked_ramps", () => {
    // Two flights stacked in plan, one storey apart: the capsule stands on
    // the one inside its step window, not on whichever footprint came first.
    const poly: [number, number][] = [
      [0.95, 6.0],
      [1.85, 6.0],
      [1.85, 11.6],
      [0.95, 11.6],
    ];
    const axis = { from: [1.4, 11.6] as [number, number], dir: 180, len: 5.6 };
    const ramps: NavRamp[] = [
      { stair: "a", y0: 0, y1: 3.6, axis, poly },
      { stair: "b", y0: 3.6, y1: 7.2, axis, poly },
    ];
    expect(floorAtRooms([], 1.4, 8.8, 1.7, ramps)).toBeCloseTo(1.8, 6);
    expect(floorAtRooms([], 1.4, 8.8, 5.3, ramps)).toBeCloseTo(5.4, 6);
    expect(floorAtRooms([], 1.4, 8.8, 5.3, [...ramps].reverse())).toBeCloseTo(5.4, 6);
    // inside a footprint only a ramp is a floor: nothing in the window, no floor
    expect(floorAtRooms([{ y: 3.6, outline: poly }], 1.4, 8.8, 3.6, ramps)).toBeNull();
  });
});
