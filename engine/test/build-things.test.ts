import { describe, it, expect, beforeAll } from "vitest";
import { runCheck } from "../src/check.js";
import { buildGeometry, meshBBox } from "../src/build/geometry.js";
import type { Geometry, Mesh } from "../src/build/geometry.js";
import { demoFlat, patched } from "./helpers/scene.js";

function built(raw: unknown): Geometry {
  const { report, ctx } = runCheck(raw);
  expect(report.errors).toEqual([]);
  return buildGeometry(ctx);
}

function byId(g: Geometry, id: string): Mesh {
  const m = g.meshes.find((x) => x.id === id);
  expect(m, `mesh ${id}`).toBeTruthy();
  return m as Mesh;
}

function centroid(m: Mesh): [number, number, number] {
  const n = m.positions.length / 3;
  const c: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < m.positions.length; i += 3) {
    c[0] += m.positions[i] / n;
    c[1] += m.positions[i + 1] / n;
    c[2] += m.positions[i + 2] / n;
  }
  return c;
}

describe("props, decals and door leaves", () => {
  let g: Geometry;
  let passport: any;
  beforeAll(() => {
    const { report, ctx } = runCheck(demoFlat());
    expect(report.errors).toEqual([]);
    passport = ctx.passport;
    g = buildGeometry(ctx);
  });

  it("test_prop_boxes_match_passport", () => {
    const props = passport.props as Array<{ id: string; obb: [number, number][]; y: [number, number] }>;
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      const m = byId(g, p.id);
      expect(m.kind).toBe("prop");
      const b = meshBBox(m);
      const xs = p.obb.map((c) => c[0]);
      const zs = p.obb.map((c) => c[1]);
      expect(b.min[0]).toBeCloseTo(Math.min(...xs), 6);
      expect(b.max[0]).toBeCloseTo(Math.max(...xs), 6);
      expect(b.min[2]).toBeCloseTo(Math.min(...zs), 6);
      expect(b.max[2]).toBeCloseTo(Math.max(...zs), 6);
      expect(b.min[1]).toBeCloseTo(p.y[0], 6);
      expect(b.max[1]).toBeCloseTo(p.y[1], 6);
    }
    const vase = meshBBox(byId(g, "vase"));
    expect(vase.min[1]).toBeCloseTo(0.75, 6);
    expect(vase.max[1]).toBeCloseTo(1.15, 6);
    const lamp = meshBBox(byId(g, "lamp"));
    expect(lamp.min[1]).toBeCloseTo(2.8, 6);
    expect(lamp.max[1]).toBeCloseTo(3.4, 6);
    // every `around` copy gets its own mesh
    expect(g.meshes.filter((m) => m.kind === "prop" && m.id.startsWith("chairs.")).length).toBe(4);
  });

  it("test_decal_plane", () => {
    const m = byId(g, "decal.0");
    expect(m.kind).toBe("decal");
    expect(m.material).toBe("d_portrait");
    expect(m.positions.length / 3).toBe(4);
    const c = centroid(m);
    expect(c[0]).toBeCloseTo(3.92, 6);
    expect(c[1]).toBeCloseTo(1.7, 6);
    expect(c[2]).toBeCloseTo(-1.6, 6);
    expect([m.normals[0], m.normals[1], m.normals[2]]).toEqual([-1, 0, 0]);
    const b = meshBBox(m);
    expect(b.max[2] - b.min[2]).toBeCloseTo(0.6, 6);
    expect(b.max[1] - b.min[1]).toBeCloseTo(0.7, 6);
  });

  it("test_door_leaf_open", () => {
    const m = byId(g, "front:leaf");
    expect(m.kind).toBe("leaf");
    expect(m.material).toBe("d_door");
    const b = meshBBox(m);
    expect(b.min[0]).toBeCloseTo(0.43, 6);
    expect(b.max[0]).toBeCloseTo(0.47, 6);
    expect(b.min[2]).toBeCloseTo(3.04, 6);
    expect(b.max[2]).toBeCloseTo(3.94, 6);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect(b.max[1]).toBeCloseTo(2.1, 6);
  });

  it("test_door_leaf_closed", () => {
    const closed = built(patched([{ op: "replace", path: "/openings/0/leaf/open", value: false }]));
    const b = meshBBox(byId(closed, "front:leaf"));
    // centred on the swing room's face of the wall (z=3.94, leaf 4 cm): the
    // plane the runtime turns it about — not in the middle of the wall
    expect(b.min[2]).toBeCloseTo(3.92, 6);
    expect(b.max[2]).toBeCloseTo(3.96, 6);
    expect(b.min[0]).toBeCloseTo(-0.45, 6);
    expect(b.max[0]).toBeCloseTo(0.45, 6);
  });

  it("test_window_backdrop", () => {
    const m = byId(g, "sea:outside");
    expect(m.kind).toBe("backdrop");
    expect(m.material).toBe("d_sea");
    expect(m.positions.length / 3).toBe(4);
    const b = meshBBox(m);
    expect(b.max[0] - b.min[0]).toBeCloseTo(2.0, 6);
    expect(b.max[1] - b.min[1]).toBeCloseTo(1.4, 6);
    expect(centroid(m)[1]).toBeCloseTo(1.5, 6);
    expect(m.room).toBe("living");
    expect(m.normals[2]).toBeGreaterThan(0);
  });
});
