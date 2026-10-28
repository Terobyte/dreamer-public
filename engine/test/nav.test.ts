import { describe, it, expect, beforeAll } from "vitest";
import { runCheck } from "../src/check.js";
import { buildNav, isWalkable } from "../src/nav/grid.js";
import { floorAt } from "../src/nav/floor.js";
import type { Ctx } from "../src/ctx.js";
import type { NavJson, Report } from "../src/types.js";
import { demoFlat, patched } from "./helpers/scene.js";

const CELL = 0.04;

describe("nav", () => {
  let ctx: Ctx;
  let report: Report;
  let nav: NavJson;

  beforeAll(() => {
    const r = runCheck(demoFlat());
    ctx = r.ctx;
    report = r.report;
    nav = ctx.nav as NavJson;
  });

  it("test_nav_probes", () => {
    expect(report.errors.filter((e) => e.stage === "nav")).toEqual([]);
    expect(isWalkable(nav, -1, 10)).toBe(true);
    expect(isWalkable(nav, 0, 4)).toBe(true);
    expect(isWalkable(nav, 0, 4.3)).toBe(true);
    expect(isWalkable(nav, 0, 0)).toBe(false);
    expect(isWalkable(nav, -4, 0)).toBe(false);
    // doorway is 0.9 wide, eroded by 2 * 0.25 -> a 0.4 m corridor
    expect(isWalkable(nav, -0.15, 4)).toBe(true);
    expect(isWalkable(nav, -0.3, 4)).toBe(false);

    const layer = nav.layers[0];
    expect(layer.origin[0]).toBeCloseTo(-4.04, 6);
    expect(layer.origin[1]).toBeCloseTo(-5.64, 6);
    expect(layer.w).toBe(202);
    expect(layer.h).toBe(442);
  });

  it("test_beam_winding_does_not_cancel_wall", () => {
    const scene = demoFlat() as any;
    scene.rooms[0].beams = [{ from: [-1.9, 4], to: [-0.6, 4], w: 0.12, h: 2, material: "wood" }];
    const r = runCheck(scene);
    expect(r.report.errors).toEqual([]);
    expect(r.report.warnings).toEqual([]);
    expect(isWalkable(r.ctx.nav as NavJson, -1.2, 4)).toBe(false);
  });

  it("test_nav_format", () => {
    expect(nav.cell).toBe(CELL);
    expect(nav.capsule).toEqual({ r: 0.25, h: 1.8, step_max: 0.25 });
    expect(nav.ramps).toEqual([]);
    expect(nav.links).toEqual([]);

    const layer = nav.layers[0];
    expect(layer.level).toBe("L0");
    for (const o of layer.origin as number[]) {
      expect(Math.abs(o / CELL - Math.round(o / CELL))).toBeLessThan(1e-9);
    }
    const bytes = Buffer.from(layer.bits as string, "base64");
    expect(bytes.length).toBe(Math.ceil((layer.w * layer.h) / 8));

    // bit of cell (i, j) is number j*w + i, LSB-first inside the byte
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 100; k++) {
      const i = Math.floor(rnd() * layer.w);
      const j = Math.floor(rnd() * layer.h);
      const n = j * layer.w + i;
      const bit = ((bytes[n >> 3] >> (n & 7)) & 1) === 1;
      const x = layer.origin[0] + (i + 0.5) * CELL;
      const z = layer.origin[1] + (j + 0.5) * CELL;
      expect(isWalkable(nav, x, z)).toBe(bit);
      expect(Math.floor((x - layer.origin[0]) / CELL + 1e-9)).toBe(i);
    }
  });

  it("test_floor_at", () => {
    expect(floorAt(ctx, 0, 0.5, 0)).toBe(0);
    expect(floorAt(ctx, 10, 10, 0)).toBe(null);
  });

  it("test_nav_codes", () => {
    const blocked = runCheck(
      patched([{ op: "replace", path: "/spawn", value: { room: "living", at: [-3.45, 1.5] } }]),
    ).report;
    const navErrs = blocked.errors.filter((e) => e.stage === "nav");
    expect(navErrs.map((e) => e.code)).toEqual(["NAV_SPAWN_BLOCKED"]);
    expect(blocked.warnings.filter((w) => w.stage === "nav")).toEqual([]);

    const rug = runCheck(
      patched([
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "rug",
            asset: "p_table",
            room: "hall",
            at: [-1, 10],
            size: { w: 2.0, d: 1.4, h: 0.01 },
            yaw: 0,
            solid: false,
          },
        },
      ]),
    ).report;
    expect(rug.errors).toEqual([]);
    expect(rug.warnings).toEqual([]);

    const cut = runCheck(patched([{ op: "replace", path: "/openings/0/width", value: 0.45 }])).report;
    expect(cut.errors).toEqual([]);
    expect(cut.warnings.map((w) => w.code)).toEqual(["NAV_ROOM_CUT"]);
  });

  it("test_leafless_opening_walkable", () => {
    const r = runCheck(patched([{ op: "remove", path: "/openings/0/leaf" }]));
    const navWarns = r.report.warnings.filter((w) => w.stage === "nav");
    expect(navWarns).toEqual([]);
    expect(isWalkable(r.ctx.nav as NavJson, 0, 4)).toBe(true);
  });

  it("test_spawn_blocked_by_prop_clearance", () => {
    const r = runCheck(patched([{ op: "replace", path: "/spawn/at", value: [-2.78, 1.5] }]));
    const navErrs = r.report.errors.filter((e) => e.stage === "nav");
    expect(navErrs.map((e) => e.code)).toEqual(["NAV_SPAWN_BLOCKED"]);
    expect(navErrs[0].msg).toContain("sofa");
  });

  it("buildNav is deterministic", () => {
    const again = buildNav(ctx);
    expect(again).toEqual(nav);
  });
});

describe("terra re-review", () => {
  it("window on an arc adds no obstacle beyond the curved wall", () => {
    // `sea` (sill 1 m) is wall for the capsule; restoring it must give back
    // the curved wall, not a chord rectangle reaching into the room
    const withWin = runCheck(demoFlat()).ctx;
    const noWin = runCheck(patched([{ op: "remove", path: "/openings/1" }])).ctx;
    const a = buildNav(withWin);
    const b = buildNav(noWin);
    expect(isWalkable(b, 0, -5.28)).toBe(true);
    expect(isWalkable(a, 0, -5.28)).toBe(true);
  });
});

describe("terra re-review 4", () => {
  it("arch through a curved shared wall is passable", () => {
    const room = (id: string, shape: any[]): any => ({ id, level: "L0", height: 3, shape, floor: "m", ceiling: "m", walls: { material: "m" } });
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "A", at: [0, -2], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: {},
      levels: [{ id: "L0", y: 0 }],
      rooms: [
        room("A", [[3, 0, { bulge: 1 }], [-3, 0], [-3, -4], [3, -4]]),
        room("B", [[-3, 0, { bulge: -1 }], [3, 0], [3, 6], [-3, 6]]),
      ],
      openings: [{ id: "arch", kind: "arch", on: { room: "A", edge: 0, t: 0.5 }, width: 0.9 }],
    };
    const { report } = runCheck(raw);
    expect([...report.errors, ...report.warnings].map((e) => e.code)).not.toContain("NAV_ROOM_CUT");
  });
});
