import { describe, it, expect } from "vitest";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";
import { meshBBox } from "../src/build/mesh.js";
import type { Mesh } from "../src/build/geometry.js";
import { isWalkable } from "../src/nav/grid.js";
import { patched } from "./helpers/scene.js";
import type { AssetFiles } from "../src/build/geometry.js";

const FREE_WALL = { level: "L0", from: [-1, 8], to: [1, 8], material: "olive" };
const COUNTER = { kind: "counter", room: "living", from: [-3.94, -3], to: [-3.94, -1], material: "wood" };

function unionBBox(ms: Mesh[]): { min: number[]; max: number[] } {
  expect(ms.length).toBeGreaterThan(0);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of ms) {
    const b = meshBBox(m);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], b.min[i]);
      max[i] = Math.max(max[i], b.max[i]);
    }
  }
  return { min, max };
}

function built(ops: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>) {
  const { report, ctx } = runCheck(patched(ops));
  return { report, ctx, geo: report.errors.length === 0 ? buildGeometry(ctx) : null };
}

const addWall = { op: "add" as const, path: "/walls", value: [FREE_WALL] };
const addCounter = { op: "add" as const, path: "/fixtures", value: [COUNTER] };

describe("free walls", () => {
  it("test_free_wall_mesh", () => {
    const { report, geo } = built([addWall]);
    expect(report.errors).toEqual([]);
    const ms = geo!.meshes.filter((m) => m.id.startsWith("walls#0:"));
    const b = unionBBox(ms);
    expect(b.min[0]).toBeCloseTo(-1, 6);
    expect(b.max[0]).toBeCloseTo(1, 6);
    expect(b.min[2]).toBeCloseTo(7.94, 6);
    expect(b.max[2]).toBeCloseTo(8.06, 6);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect(b.max[1]).toBeCloseTo(3.4, 6);
  });

  it("test_free_wall_default_height", () => {
    const { geo } = built([addWall]);
    const b = unionBBox(geo!.meshes.filter((m) => m.id.startsWith("walls#0:")));
    expect(b.max[1]).toBeCloseTo(3.4, 6);
  });

  it("test_free_wall_blocks", () => {
    const { ctx } = built([addWall]);
    expect(isWalkable(ctx.nav!, 0, 8)).toBe(false);

    const { report } = built([
      addWall,
      {
        op: "add",
        path: "/props/-",
        value: { id: "box", asset: "p_table", room: "hall", at: [0, 8], size: { w: 0.5, d: 0.5, h: 0.5 }, yaw: 0 },
      },
    ]);
    const hit = report.errors.find((e) => e.code === "PROP_HITS_WALL");
    expect(hit, JSON.stringify(report.errors)).toBeDefined();
    expect(hit!.msg).toContain("walls#0");
  });

  it("test_free_wall_height_limits_prop_hit", () => {
    // F12: the wall body is flat, so a knee-high free wall used to report
    // PROP_HITS_WALL against a prop hanging well above it
    const { report } = built([
      { op: "add", path: "/walls", value: [{ ...FREE_WALL, h: 1 }] },
      {
        op: "add",
        path: "/props/-",
        value: {
          id: "ceiling-box",
          asset: "p_table",
          room: "hall",
          at: [0, 8],
          size: { w: 0.5, d: 0.5, h: 0.5 },
          yaw: 0,
          mount: "ceiling",
          solid: true,
        },
      },
    ]);
    expect(report.errors.map((e) => e.code)).toEqual([]);
  });

  it("test_free_wall_both_faces_own_material", () => {
    const { geo } = built([addWall]);
    const ms = geo!.meshes.filter((m) => m.id.startsWith("walls#0:") && m.kind === "wall");
    const materials = new Set(ms.map((m) => m.material));
    expect([...materials]).toEqual(["olive"]);
  });

  it("test_free_wall_glass_is_transparent_but_solid", () => {
    const { geo, ctx } = built([{ op: "add", path: "/walls", value: [{ ...FREE_WALL, glass: true }] }]);
    const ms = geo!.meshes.filter((m) => m.id.startsWith("walls#0:") && m.kind === "wall");
    for (const m of ms) {
      expect(geo!.materials[m.material]?.transparent).toBe(true);
    }
    expect(isWalkable(ctx.nav!, 0, 8)).toBe(false);
  });
});

describe("free wall / fixture refs", () => {
  it("test_wall_bad_level_ref", () => {
    const { report } = built([{ op: "add", path: "/walls", value: [{ ...FREE_WALL, level: "nope" }] }]);
    expect(report.errors.some((e) => e.code === "REF_UNKNOWN" && e.path === "/walls/0/level")).toBe(true);
  });

  it("test_wall_bad_material_ref", () => {
    const { report } = built([{ op: "add", path: "/walls", value: [{ ...FREE_WALL, material: "nope" }] }]);
    expect(report.errors.some((e) => e.code === "REF_UNKNOWN" && e.path === "/walls/0/material")).toBe(true);
  });

  it("test_fixture_bad_room_ref", () => {
    const { report } = built([{ op: "add", path: "/fixtures", value: [{ ...COUNTER, room: "nope" }] }]);
    expect(report.errors.some((e) => e.code === "REF_UNKNOWN" && e.path === "/fixtures/0/room")).toBe(true);
  });

  it("test_fixture_bad_material_and_top_ref", () => {
    const { report } = built([{ op: "add", path: "/fixtures", value: [{ ...COUNTER, material: "nope", top: "nope2" }] }]);
    expect(report.errors.some((e) => e.code === "REF_UNKNOWN" && e.path === "/fixtures/0/material")).toBe(true);
    expect(report.errors.some((e) => e.code === "REF_UNKNOWN" && e.path === "/fixtures/0/top")).toBe(true);
  });
});

describe("fixtures", () => {
  it("test_fixture_counter", () => {
    const { report, geo } = built([addCounter]);
    expect(report.errors).toEqual([]);
    const body = geo!.meshes.find((m) => m.id === "fixture.0");
    expect(body).toBeDefined();
    const b = meshBBox(body!);
    expect(b.min[0]).toBeCloseTo(-3.94, 6);
    expect(b.max[0]).toBeCloseTo(-3.34, 6);
    expect(b.min[2]).toBeCloseTo(-3, 6);
    expect(b.max[2]).toBeCloseTo(-1, 6);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect(b.max[1]).toBeCloseTo(0.9, 6);

    const top = geo!.meshes.find((m) => m.id === "fixture.0:top");
    expect(top).toBeDefined();
    expect(top!.positions.length).toBe(12);
    for (let i = 1; i < top!.positions.length; i += 3) expect(top!.positions[i]).toBeCloseTo(0.9, 6);
  });

  it("test_fixture_cabinet_wall", () => {
    const { report, geo } = built([
      { op: "add", path: "/fixtures", value: [{ ...COUNTER, kind: "cabinet-wall" }] },
    ]);
    expect(report.errors).toEqual([]);
    const b = meshBBox(geo!.meshes.find((m) => m.id === "fixture.0")!);
    expect(b.min[1]).toBeCloseTo(1.45, 6);
    expect(b.max[1]).toBeCloseTo(2.15, 6);
    expect(b.min[0]).toBeCloseTo(-3.94, 6);
    expect(b.max[0]).toBeCloseTo(-3.59, 6);
    expect(b.min[2]).toBeCloseTo(-3, 6);
    expect(b.max[2]).toBeCloseTo(-1, 6);
  });

  it("test_fixture_hits_prop", () => {
    const crate = {
      op: "add" as const,
      path: "/props/-",
      value: { id: "crate", asset: "p_vase", room: "living", at: [-3.64, -2], size: { w: 0.3, d: 0.3, h: 0.3 }, yaw: 0 },
    };
    const clean = built([crate]);
    expect(clean.report.errors).toEqual([]);

    const { report } = built([addCounter, crate]);
    expect(report.errors.map((e) => e.code)).toEqual(["PROP_HITS_PROP"]);
    expect(report.errors[0].msg).toContain("fixture.0");
  });

  it("test_fixture_shallow_depth_goes_into_room", () => {
    // F10: back edge sits on the room's inner wall face, so a too-short probe
    // at `±depth` can land inside the room on both sides and tie; the tie
    // must resolve toward the room, not toward the wall it backs onto.
    const { report, geo } = built([
      { op: "add", path: "/fixtures", value: [{ ...COUNTER, depth: 0.01 }] },
    ]);
    expect(report.errors).toEqual([]);
    const b = meshBBox(geo!.meshes.find((m) => m.id === "fixture.0")!);
    expect(b.min[0]).toBeCloseTo(-3.94, 6);
    expect(b.max[0]).toBeCloseTo(-3.93, 6);
  });

  it("test_fixture_shallow_depth_concave_room", () => {
    // F11: the tie between the two probes used to be broken by the room's
    // centroid, which in an L-shaped room can sit on the far side of the
    // local boundary; the back edge here lies on the inner face of the
    // z = 7 wall, so the body must grow toward smaller z.
    const ell = {
      op: "add" as const,
      path: "/rooms/-",
      value: {
        id: "ell",
        level: "L0",
        height: 3.0,
        shape: [[2, 6], [6, 6], [6, 7], [3, 7], [3, 10], [2, 10]],
        floor: "parquet",
        ceiling: "white",
        walls: { material: "white" },
      },
    };
    const door = {
      op: "add" as const,
      path: "/openings/-",
      value: { id: "to-ell", kind: "door", at: [2, 8], width: 0.9, height: 2.1, sill: 0, leaf: { decal: "d_door", open: true } },
    };
    const { report, geo } = built([
      ell,
      door,
      { op: "add", path: "/fixtures", value: [{ kind: "counter", room: "ell", from: [6, 6.94], to: [3, 6.94], material: "wood", depth: 0.01 }] },
    ]);
    expect(report.errors).toEqual([]);
    const b = meshBBox(geo!.meshes.find((m) => m.id === "fixture.0")!);
    expect(b.min[2]).toBeCloseTo(6.93, 6);
    expect(b.max[2]).toBeCloseTo(6.94, 6);
  });

  it("test_fixture_hits_prop_across_room_tag", () => {
    // F7: the fixture's `room` field is "living", but its authored from/to
    // sits physically inside "hall" (living does not reach z=6); the prop
    // that collides with it lives in "hall" too. The check must not miss
    // this just because the fixture's own `room` tag differs.
    const crossCounter = {
      op: "add" as const,
      path: "/fixtures",
      value: [{ kind: "counter", room: "living", from: [-0.3, 6], to: [0.3, 6], material: "wood" }],
    };
    const hallProp = {
      op: "add" as const,
      path: "/props/-",
      value: { id: "box", asset: "p_table", room: "hall", at: [0, 5.55], size: { w: 0.5, d: 0.5, h: 0.5 }, yaw: 0 },
    };
    const { report } = built([crossCounter, hallProp]);
    expect(report.errors.map((e) => e.code)).toEqual(["PROP_HITS_PROP"]);
    expect(report.errors[0].msg).toContain("fixture.0");
  });
});

describe("free wall blocking findings", () => {
  it("test_free_wall_on_roomless_level_requires_h", () => {
    // F8: a roomless level has no room heights to take a max of; `h: null`
    // must not silently fall back to 0 and make the wall vanish
    const { report } = built([
      { op: "add", path: "/levels/-", value: { id: "L1", y: 5 } },
      { op: "add", path: "/walls", value: [{ level: "L1", from: [0, 0], to: [2, 0], material: "olive" }] },
    ]);
    expect(report.errors.map((e) => e.code)).toEqual(["SCHEMA_REQUIRED"]);
    expect(report.errors[0].path).toBe("/walls/0/h");
  });

  it("test_free_wall_on_roomless_level", () => {
    const { report, geo } = built([
      { op: "add", path: "/levels/-", value: { id: "L1", y: 5 } },
      { op: "add", path: "/walls", value: [{ level: "L1", from: [0, 0], to: [2, 0], material: "olive", h: 2.5 }] },
    ]);
    expect(report.errors).toEqual([]);
    const ms = geo!.meshes.filter((m) => m.id.startsWith("walls#0:"));
    const b = unionBBox(ms);
    expect(b.min[1]).toBeCloseTo(5, 6);
    expect(b.max[1]).toBeCloseTo(7.5, 6);
  });

  it("test_glass_id_does_not_collide_with_authored_material", () => {
    const { report, geo } = built([
      { op: "add", path: "/materials/olive$glass:1", value: { color: "#ff00ff" } },
      {
        op: "add",
        path: "/walls",
        value: [
          { level: "L0", from: [-1, 8], to: [1, 8], material: "wood" },
          { level: "L0", from: [-1, 7], to: [1, 7], material: "olive", glass: true },
        ],
      },
    ]);
    expect(report.errors).toEqual([]);
    expect(geo!.materials["olive$glass:1"]).toEqual({ color: "#ff00ff" });
    const ms = geo!.meshes.filter((m) => m.id.startsWith("walls#1:") && m.kind === "wall");
    for (const m of ms) expect(geo!.materials[m.material]?.transparent).toBe(true);
  });

  it("test_glass_id_does_not_collide_with_asset_id", () => {
    // the glass variant of free wall #0 is named "olive$glass:0"; an asset
    // that happens to already own that id must keep its own map, and the
    // glass wall must get a further-escaped id instead of overwriting it
    const { report, ctx } = runCheck(
      patched([
        { op: "add", path: "/assets/olive$glass:0", value: { kind: "decal", prompt: "x" } },
        { op: "add", path: "/walls", value: [{ ...FREE_WALL, glass: true }] },
      ]),
    );
    expect(report.errors).toEqual([]);
    const assetFiles: AssetFiles = { "olive$glass:0": "assets/olive$glass:0.png" };
    const geo = buildGeometry(ctx, assetFiles);
    expect(geo.materials["olive$glass:0"].map).toBe("assets/olive$glass:0.png");
    const ms = geo.meshes.filter((m) => m.id.startsWith("walls#0:") && m.kind === "wall");
    for (const m of ms) {
      // a decal material is transparent too, so this alone would pass even if
      // the wall wrongly reused the asset's own id instead of an escaped one
      expect(m.material).not.toBe("olive$glass:0");
      expect(geo.materials[m.material]?.transparent).toBe(true);
    }
  });
});

describe("schema", () => {
  it("test_future_fields_gone", () => {
    const { report } = built([addWall, addCounter]);
    expect(report.errors.filter((e) => e.code === "SCHEMA_FUTURE_FIELD")).toEqual([]);
    expect(report.errors).toEqual([]);
  });
});
