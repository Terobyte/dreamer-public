import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/check.js";
import { doorDefs, doorMeshes } from "../src/build/doors.js";
import { isWalkableMask } from "../src/nav/grid.js";
import type { OpeningGeo } from "../src/openings/resolve.js";
import { demoFlat, patched } from "./helpers/scene.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

describe("doors: build", () => {
  let build: any;
  let nav: any;
  let passport: OpeningGeo;

  beforeAll(() => {
    const dist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
    const r = spawnSync(
      "node",
      ["--import", "tsx", "bin/dreamer.ts", "build", DEMO, "--out", dist, "--assets", "none", "--cache", mkdtempSync(join(tmpdir(), "dreamer-cache-"))],
      { cwd: ENGINE, encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(`build failed: ${r.stderr}${r.stdout}`);
    build = JSON.parse(readFileSync(join(dist, "build.json"), "utf-8"));
    nav = JSON.parse(readFileSync(join(dist, "nav.json"), "utf-8"));
    const ctx = runCheck(demoFlat()).ctx;
    passport = ((ctx.openings ?? []) as OpeningGeo[]).find((g) => g.id === "front")!;
  }, 60_000);

  it("test_build_json_doors_match_passport", () => {
    const d = build.doors.find((x: any) => x.id === "front");
    expect(d).toBeDefined();
    expect(d.hinge_at).toEqual(passport.hingeAt);
    expect(d.swing).toBe(passport.swing);
    expect(d.rooms).toEqual(passport.rooms);
    expect(d.width).toBeCloseTo(0.9, 6);
    expect(d.height).toBeCloseTo(2.1, 6);
    expect(d.open).toBe(true);
    // windows have no leaf to swing
    expect(build.doors.some((x: any) => x.id === "sea")).toBe(false);
  });

  it("test_nav_route_through_door_blocked_when_closed", () => {
    // the doorway (0, 4): walkable with the leaf open, a wall with it closed
    expect(isWalkableMask(nav, 0, 4, "open")).toBe(true);
    expect(isWalkableMask(nav, 0, 4, "closed")).toBe(false);
    expect(isWalkableMask(nav, -0.15, 4, "closed")).toBe(false);
    // away from the door both masks agree
    expect(isWalkableMask(nav, -1, 10, "closed")).toBe(true);
    expect(isWalkableMask(nav, -1, 10, "open")).toBe(true);
    // the runtime toggles one door's cells without a rebuild
    const cells: number[] = nav.doors.front.cells;
    expect(cells.length).toBeGreaterThan(0);
    expect(nav.doors.front.level).toBe("L0");
  });
});

function bboxOf(m: { positions: number[] }): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < m.positions.length; k += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], m.positions[k + a]);
      max[a] = Math.max(max[a], m.positions[k + a]);
    }
  }
  return { min, max };
}

function distPtBBox(p: number[], b: { min: number[]; max: number[] }): number {
  let d2 = 0;
  for (let a = 0; a < 3; a++) {
    const c = Math.min(Math.max(p[a], b.min[a]), b.max[a]);
    d2 += (p[a] - c) * (p[a] - c);
  }
  return Math.sqrt(d2);
}

describe("doors: closed leaf sits on the hinge plane, handle on the far edge", () => {
  it("test_closed_leaf_on_hinge_plane_with_handle", () => {
    const scene = patched([{ op: "replace", path: "/openings/0/leaf/open", value: false }]);
    const ctx = runCheck(scene).ctx as any;
    const meshes = doorMeshes(ctx);
    const leaf = meshes.find((m: any) => m.id === "front:leaf");
    expect(leaf).toBeDefined();
    const g = (ctx.openings as OpeningGeo[]).find((x) => x.id === "front")!;
    // the runtime turns the leaf about hinge_at: the built closed leaf must
    // already contain that point (half leaf thickness of slack)
    expect(distPtBBox([g.hingeAt![0], g.sill + 1, g.hingeAt![1]], bboxOf(leaf))).toBeLessThan(0.025);
    // the handle is a small box on the edge opposite the hinge
    const handle = meshes.find((m: any) => m.id === "front:handle");
    expect(handle).toBeDefined();
    const def = doorDefs(ctx).find((d) => d.id === "front")!;
    const hb = bboxOf(handle);
    const hc = [(hb.min[0] + hb.max[0]) / 2, (hb.min[2] + hb.max[2]) / 2];
    expect(Math.hypot(hc[0] - def.closed_end[0], hc[1] - def.closed_end[1])).toBeLessThan(0.2);
  });

  it("test_open_leaf_keeps_handle", () => {
    const ctx = runCheck(demoFlat()).ctx as any;
    const meshes = doorMeshes(ctx);
    expect(meshes.some((m: any) => m.id === "front:leaf")).toBe(true);
    expect(meshes.some((m: any) => m.id === "front:handle")).toBe(true);
  });

  it("test_leaf_on_upper_level_sits_on_level_floor", () => {
    const scene: any = JSON.parse(readFileSync(join(ENGINE, "../specs/examples/demo.scene.json"), "utf-8"));
    scene.openings.push({
      id: "loft-exit",
      kind: "door",
      at: [0, 10.5],
      width: 0.9,
      height: 2.1,
      sill: 0,
      outside: { backdrop: "d_sea" },
      leaf: { decal: "d_door", open: false },
    });
    const ctx = runCheck(scene).ctx as any;
    const leaf = doorMeshes(ctx).find((m: any) => m.id === "loft-exit:leaf");
    expect(leaf).toBeDefined();
    const ys = leaf.positions.filter((_: number, i: number) => i % 3 === 1);
    // L1 floor is at y=3.6: the leaf spans 3.6..5.7, not 0..2.1
    expect(Math.min(...ys)).toBeCloseTo(3.6, 6);
    expect(Math.max(...ys)).toBeCloseTo(5.7, 6);
  });
});
