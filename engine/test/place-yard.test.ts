// A real courtyard (h0/place): yard strips side by side, buildings seen only from outside, pictures on walls.
import { describe, it, expect } from "vitest";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";

const strip = (id: string, x0: number, x1: number, floor: string) => ({
  id, level: "L0", open: true, floor, shape: [[x0, -10], [x1, -10], [x1, 0], [x0, 0]],
});
const scene = (extra: any = {}) => ({
  version: 0, name: "t",
  spawn: { room: "a", at: [2, -5], yaw: 0 },
  style: { ambient: 1, exterior: "#cccccc" },
  materials: { g: { color: "#556b2f" }, d: { color: "#444444" }, w: { color: "#dddddd" }, f: { color: "#aa9988" } },
  levels: [{ id: "L0", y: 0 }],
  assets: {},
  rooms: [
    strip("a", 0, 6, "d"), strip("b", 6, 10, "g"),
    // a block of flats behind the yard: no door, a facade and a roof
    { id: "house", level: "L0", height: 6, shape: [[0, 0], [10, 0], [10, 8], [0, 8]].reverse(), floor: "w", ceiling: "w",
      walls: { material: "w" }, facade: "f", roof: { material: "w", kind: "flat" } },
  ],
  ...extra,
});

describe("place yard", () => {
  it("open strips sharing an edge are one walkable yard; a doorless building is scenery", () => {
    const { report } = runCheck(scene() as any);
    expect(report.errors).toEqual([]);
    const codes = report.warnings.map((e: any) => e.code);
    expect(codes).not.toContain("NAV_ROOM_CUT");
  });

  it("a closed room without facade or roof and no door is still unreachable", () => {
    const s: any = scene();
    s.rooms.push({ id: "box", level: "L0", height: 3, shape: [[20, 0], [24, 0], [24, 4], [20, 4]], floor: "w", ceiling: "w", walls: { material: "w" } });
    const { report } = runCheck(s);
    expect(report.errors.map((e: any) => e.code)).toContain("ROOM_UNREACHABLE");
  });

  it("a picture on a wall reads left to right for a viewer facing it", () => {
    const s: any = scene({
      assets: { sign: { kind: "decal", prompt: "a sign" } },
      decals: [{ asset: "sign", room: "a", at: [3, -0.05], y: 2, size: { w: 2, h: 1 } }],
    });
    const { ctx, report } = runCheck(s);
    expect(report.errors).toEqual([]);
    const m = buildGeometry(ctx).meshes.find((x: any) => x.kind === "decal")!;
    const p = m.positions, uv = m.uvs!, n = m.normals!;
    // the viewer stands at +n looking along -n; right = (n.z, 0, -n.x)
    const right = [n[2], 0, -n[0]];
    const i0 = [0, 1, 2, 3].find((i) => uv[2 * i] === 0 && uv[2 * i + 1] === 0)!;
    const i1 = [0, 1, 2, 3].find((i) => uv[2 * i] === 1 && uv[2 * i + 1] === 0)!;
    const dx = p[3 * i1] - p[3 * i0], dz = p[3 * i1 + 2] - p[3 * i0 + 2];
    expect(dx * right[0] + dz * right[2]).toBeGreaterThan(0);
  });
});
