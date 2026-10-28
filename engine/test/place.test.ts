import { describe, expect, beforeAll, test } from "vitest";
import { runCheck } from "../src/check.js";
import { signedArea } from "../src/geom/poly.js";
import { obbCorners } from "../src/geom/obb.js";
import { compileRooms } from "../src/plan/rooms.js";
import { closestOnEdge, placeProps } from "../src/props/place.js";
import type { PropGeo } from "../src/types.js";
import { round3 } from "../src/report/report.js";
import { demoFlat, patched } from "./helpers/scene.js";
import type { Report } from "../src/types.js";

let flatReport: Report;
let flatCtx: any;

beforeAll(() => {
  const out = runCheck(demoFlat(), { until: "props" });
  flatReport = out.report;
  flatCtx = out.ctx;
});

function propOf(ctx: any, id: string): any {
  return (ctx.props as any[]).find((p) => p.id === id);
}

function aabbOf(o: any): [number, number, number, number] {
  const pts = obbCorners(o);
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

describe("props", () => {
  test("test_demo_flat_chairs", () => {
    expect(flatReport.errors.filter((e) => e.stage === "props")).toEqual([]);
    const want: Array<[number, number, number]> = [
      [0, 0.9, 180],
      [0.9, 0, 270],
      [0, -0.9, 0],
      [-0.9, 0, 90],
    ];
    want.forEach(([x, z, yaw], k) => {
      const p = propOf(flatCtx, `chairs.${k}`);
      expect(p, `chairs.${k}`).toBeTruthy();
      expect(p.copy).toBe(k);
      expect(p.obb.c[0]).toBeCloseTo(x, 6);
      expect(p.obb.c[1]).toBeCloseTo(z, 6);
      expect(p.obb.yaw).toBeCloseTo(yaw, 6);
    });
  });

  test("test_demo_flat_sofa_lamp_vase", () => {
    const sofa = propOf(flatCtx, "sofa");
    expect(sofa.obb.yaw).toBeCloseTo(90, 6);
    const [x0, z0, x1, z1] = aabbOf(sofa.obb);
    expect(x0).toBeCloseTo(-3.9, 6);
    expect(x1).toBeCloseTo(-3.0, 6);
    expect(z0).toBeCloseTo(0.5, 6);
    expect(z1).toBeCloseTo(2.5, 6);

    const lamp = propOf(flatCtx, "lamp");
    expect(lamp.y[0]).toBeCloseTo(2.8, 6);
    expect(lamp.y[1]).toBeCloseTo(3.4, 6);

    const vase = propOf(flatCtx, "vase");
    expect(vase.y[0]).toBeCloseTo(0.75, 6);
    expect(vase.y[1]).toBeCloseTo(1.15, 6);
    expect(vase.obb.c[0]).toBeCloseTo(0, 6);
    expect(vase.obb.c[1]).toBeCloseTo(0, 6);
  });

  test("test_four_yaws", () => {
    const cases: Array<[[number, number], number, number, number]> = [
      [[0, 0], 0, 2.0, 0.5],
      [[1, -2.5], 90, 0.5, 2.0],
      [[0, -3.5], 180, 2.0, 0.5],
      [[-1, -2.5], 270, 0.5, 2.0],
    ];
    for (const [target, yaw, w, d] of cases) {
      const { ctx } = runCheck(
        patched([
          {
            op: "add",
            path: "/props/-",
            value: {
              id: "probe",
              asset: "p_table",
              room: "living",
              at: [0, -2.5],
              size: { w: 2.0, d: 0.5, h: 0.5 },
              mount: "floor",
              face: target,
            },
          },
        ]),
        { until: "props" },
      );
      const p = propOf(ctx, "probe");
      expect(p.obb.yaw).toBeCloseTo(yaw, 6);
      const [x0, z0, x1, z1] = aabbOf(p.obb);
      expect(round3(x1 - x0)).toBe(w);
      expect(round3(z1 - z0)).toBe(d);
    }
  });

  test("test_ceiling_under_beam", () => {
    const { ctx } = runCheck(
      patched([{ op: "replace", path: "/props/4/at", value: [0, 0] }]),
      { until: "props" },
    );
    const lamp = propOf(ctx, "lamp");
    expect(lamp.y[0]).toBeCloseTo(2.5, 6);
    expect(lamp.y[1]).toBeCloseTo(3.1, 6);
  });

  test("test_wall_mount", () => {
    const { ctx } = runCheck(
      patched([
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "cab",
            asset: "p_table",
            room: "living",
            at: [-3.5, 1],
            size: { w: 0.8, d: 0.4, h: 0.8 },
            mount: "wall",
            y: 1.0,
          },
        },
      ]),
      { until: "props" },
    );
    const p = propOf(ctx, "cab");
    expect(p.obb.c[0]).toBeCloseTo(-3.72, 6);
    expect(p.obb.c[1]).toBeCloseTo(1, 6);
    expect(p.obb.yaw).toBeCloseTo(90, 6);
    expect(p.wall).toBe("living#0");
    expect(p.y[0]).toBeCloseTo(1.0, 6);
    expect(p.y[1]).toBeCloseTo(1.8, 6);
  });

  test("wall mount needs an edge strictly closer than 1.0 m", () => {
    // `living` axis at x = -4, so `at` is exactly WALL_SEARCH away: not "closer than"
    const { ctx } = runCheck(
      patched([
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "farCab",
            asset: "p_table",
            room: "living",
            at: [-3, 1],
            size: { w: 0.8, d: 0.4, h: 0.8 },
            mount: "wall",
            y: 1.0,
          },
        },
      ]),
      { until: "props" },
    );
    expect(propOf(ctx, "farCab")).toBeUndefined();
  });

  test("test_arc_wall_mount_chord", () => {
    const { ctx } = runCheck(
      patched([
        { op: "replace", path: "/rooms/0/shape/1/2/bulge", value: -0.4 },
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "arcCab",
            asset: "p_table",
            room: "living",
            on: { room: "living", edge: 1, t: 0.5 },
            size: { w: 2, d: 0.4, h: 0.8 },
            mount: "wall",
          },
        },
      ]),
      { until: "props" },
    );
    const p = propOf(ctx, "arcCab");
    expect(p.obb.c[0]).toBeCloseTo(0, 6);
    expect(p.obb.c[1]).toBeCloseTo(-2.12, 6);
    expect(p.wall).toBe("living#1");
  });

  test("test_arc_wall_mount_circle_chord", () => {
    const scene: any = {
      rooms: [
        {
          id: "round",
          level: "L0",
          height: 3,
          circle: { c: [0, 0], r: 5 },
          floor: "parquet",
          ceiling: "plaster",
          walls: { material: "olive", thickness: 0.12 },
        },
      ],
      props: [
        {
          id: "shelf",
          asset: "p_table",
          room: "round",
          on: { room: "round", edge: 0, m: 0 },
          size: { w: 2, d: 0.4, h: 0.8 },
          mount: "wall",
        },
      ],
    };
    const { rooms } = compileRooms(scene);
    const ctx: any = {
      scene,
      rooms,
      openings: [],
      passport: { edges: [], snaps: [], openings: [], props: [], decals: [] },
    };
    const [p] = placeProps(ctx) as PropGeo[];
    expect(p.obb.yaw).toBeCloseTo(180, 6);
    expect(p.obb.c[0]).toBeCloseTo(0, 6);
    expect(p.wall).toBe("round#0");
    // inner face at 5 - 0.06 = 4.94; chord ends on face - 0.02 gap
    const corners = obbCorners(p.obb);
    const radii = corners.map((c) => Math.hypot(c[0], c[1]));
    for (const r of radii) expect(r).toBeLessThanOrEqual(4.94);
    const back = corners.filter((c) => c[1] === Math.max(...corners.map((q) => q[1])));
    expect(back).toHaveLength(2);
    for (const c of back) expect(Math.hypot(c[0], c[1])).toBeCloseTo(4.92, 6);
  });

  test("test_face_later_prop", () => {
    const { ctx } = runCheck(
      patched([
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "looker",
            asset: "p_vase",
            room: "living",
            at: [2, 2],
            size: { w: 0.3, d: 0.3, h: 0.4 },
            mount: "floor",
            face: "target2",
          },
        },
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "target2",
            asset: "p_vase",
            room: "living",
            at: [2, 0],
            size: { w: 0.3, d: 0.3, h: 0.4 },
            mount: "floor",
            yaw: 0,
          },
        },
      ]),
      { until: "props" },
    );
    const target = propOf(ctx, "target2");
    expect(target).toBeTruthy();
    const looker = propOf(ctx, "looker");
    expect(looker).toBeTruthy();
    expect(looker.obb.yaw).toBeCloseTo(180, 6);
  });

  test("test_neg_sweep_az_start", () => {
    const mk = (on: any) =>
      runCheck(
        patched([
          {
            op: "add",
            path: "/props/-",
            value: {
              id: "s",
              asset: "p_table",
              room: "living",
              on,
              size: { w: 0.6, d: 0.3, h: 0.5 },
              mount: "wall",
            },
          },
        ]),
        { until: "props" },
      ).ctx;
    const fromT0 = propOf(mk({ room: "living", edge: 1, t: 0 }), "s");
    const fromAz = propOf(mk({ room: "living", edge: 1, az: 223.6028189727036 }), "s");
    expect(fromAz).toBeTruthy();
    expect(fromAz.obb.c[0]).toBeCloseTo(fromT0.obb.c[0], 6);
    expect(fromAz.obb.c[1]).toBeCloseTo(fromT0.obb.c[1], 6);
    expect(fromAz.obb.yaw).toBeCloseTo(fromT0.obb.yaw, 6);
    expect(fromAz.wall).toBe("living#1");
  });

  test("test_red_level_elevation", () => {
    const scene: any = {
      levels: [
        { id: "L0", y: 0 },
        { id: "L1", y: 3.6 },
      ],
      rooms: [
        {
          id: "upper",
          level: "L1",
          height: 3,
          walls: { thickness: 0.12 },
          shape: [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
          ],
        },
      ],
      props: [
        {
          id: "upperTable",
          room: "upper",
          at: [2, 2],
          size: { w: 1, d: 1, h: 0.75 },
          mount: "floor",
          yaw: 0,
        },
      ],
    };
    const { rooms } = compileRooms(scene);
    const ctx: any = {
      scene,
      rooms,
      openings: [],
      passport: { edges: [], snaps: [], openings: [], props: [], decals: [] },
    };
    const [p] = placeProps(ctx) as PropGeo[];
    expect(p.y[0]).toBeCloseTo(3.6, 6);
    expect(p.y[1]).toBeCloseTo(4.35, 6);
  });

  test("test_red_passport_source_order", () => {
    const { ctx } = runCheck(
      patched([
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "looker",
            asset: "p_vase",
            room: "living",
            at: [2, 2],
            size: { w: 0.3, d: 0.3, h: 0.4 },
            mount: "floor",
            face: "target2",
          },
        },
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "target2",
            asset: "p_vase",
            room: "living",
            at: [2, 0],
            size: { w: 0.3, d: 0.3, h: 0.4 },
            mount: "floor",
            yaw: 0,
          },
        },
      ]),
      { until: "props" },
    );
    const ids = (ctx.passport.props as any[]).map((p) => p.id);
    expect(ids.indexOf("looker")).toBeLessThan(ids.indexOf("target2"));
  });

  test("around copies on top of their support", () => {
    const { ctx } = runCheck(
      patched([
        {
          op: "add",
          path: "/props/-",
          value: {
            id: "cups",
            asset: "p_vase",
            room: "living",
            around: { center: "table", n: 1, r: 0.3, start: 0 },
            size: { w: 0.1, d: 0.1, h: 0.1 },
            mount: { top_of: "table" },
            solid: false,
          },
        },
      ]),
      { until: "props" },
    );
    const cup = propOf(ctx, "cups.0");
    expect(cup).toBeTruthy();
    expect(cup.y[0]).toBeCloseTo(0.75, 6);
    expect(cup.y[1]).toBeCloseTo(0.85, 6);
  });

  test("test_passport_props", () => {
    const entry = (flatReport.passport.props as any[]).find((p) => p.id === "chairs.0");
    expect(entry).toBeTruthy();
    expect(entry.obb).toHaveLength(4);
    expect(signedArea(entry.obb)).toBeGreaterThan(0);
    expect(entry.aabb).toEqual([
      [-0.25, 0.65],
      [0.25, 1.15],
    ]);
    expect(entry.yaw).toBe(180);
    expect(entry.wall).toBe(null);
  });
  test("test_wall_mount_shared_wall_unequal_thickness", () => {
    const room = (id: string, x0: number, t: number): any => ({
      id,
      level: "L0",
      height: 3,
      shape: [[x0, 0], [x0 + 4, 0], [x0 + 4, 4], [x0, 4]],
      floor: "parquet",
      ceiling: "plaster",
      walls: { material: "olive", thickness: t },
    });
    const scene: any = {
      version: 0,
      name: "shared",
      spawn: { room: "a", at: [2, 2], yaw: 0 },
      materials: { olive: { color: "#887744" }, parquet: { color: "#aa8866" }, plaster: { color: "#eeeeee" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [room("a", 0, 0.12), room("b", 4, 0.4)],
      openings: [{ id: "ab", kind: "door", at: [4, 0.6], width: 0.8, height: 2.1, sill: 0 }],
      props: [
        {
          id: "shelf",
          asset: "p_shelf",
          room: "a",
          on: { room: "a", edge: 1, t: 0.5 },
          size: { w: 1, d: 0.4, h: 0.8 },
          mount: "wall",
        },
      ],
      assets: { p_shelf: { kind: "object", prompt: "a shelf" } },
    };
    const { report, ctx } = runCheck(scene, { until: "props" });
    expect(report.errors).toEqual([]);
    const p = propOf(ctx, "shelf");
    expect(p.obb.yaw).toBeCloseTo(270, 6);
    // merged wall takes the thicker side: inner face 4 - 0.2 = 3.8, gap 0.02
    expect(p.obb.c[0]).toBeCloseTo(3.58, 6);
    expect(p.obb.c[1]).toBeCloseTo(2, 6);
    expect(Math.max(...obbCorners(p.obb).map((c) => c[0]))).toBeCloseTo(3.78, 6);
  });
});

describe("terra re-review", () => {
  test("test_top_of_face_coincident_target", () => {
    // vase sits on the table centre [0,0]; facing that same point is undefined
    for (const face of [[0, 0], "table"]) {
      const { report } = runCheck(patched([
        { op: "remove", path: "/props/3/yaw" },
        { op: "add", path: "/props/3/face", value: face },
      ]), { until: "props" });
      expect(report.errors.map((e) => [e.code, e.path])).toEqual([["POS_INVALID", "/props/3/face"]]);
    }
  });

  test("test_closest_on_arc_outside_sweep_takes_nearer_end", () => {
    const e: any = {
      id: "r#0", room: "r", i: 0, from: [0, 1], to: [1, 0],
      arc: { c: [0, 0], r: 1, sweep: Math.PI / 2 }, len: Math.PI / 2, normalIn: [0, -1],
    };
    const { q, d } = closestOnEdge([-0.1, 0.995], e);
    expect(q[0]).toBeCloseTo(0, 9);
    expect(q[1]).toBeCloseTo(1, 9);
    expect(d).toBeCloseTo(Math.hypot(0.1, 0.005), 9);
  });

  test("test_face_target_resolved_wall_position", () => {
    // `cab` is pulled onto living#0; a prop standing exactly where it resolves
    // and facing it has no direction
    const cab = { id: "cab", asset: "p_vase", cat: "vase", room: "living", at: [-3.5, 1], size: { w: 0.3, d: 0.28, h: 0.3 }, mount: "wall", y: 1.5, solid: false };
    const first = runCheck(patched([{ op: "add", path: "/props/-", value: cab }]), { until: "props" });
    const c = (first.ctx.props as PropGeo[]).find((p) => p.id === "cab")!.obb.c;
    const { report } = runCheck(patched([
      { op: "add", path: "/props/-", value: cab },
      { op: "add", path: "/props/-", value: { id: "pot", asset: "p_vase", cat: "vase", room: "living", at: [c[0], c[1]], size: { w: 0.2, d: 0.2, h: 0.3 }, face: "cab", solid: false } },
    ]), { until: "props" });
    expect(report.errors.map((e) => [e.code, e.path])).toEqual([["POS_INVALID", "/props/6/face"]]);
  });

  test("test_face_room_uses_merged_wall_thickness", () => {
    const room = (id: string, x0: number, x1: number, t?: number): any => ({
      id, level: "L0", height: 3, shape: [[x0, 0], [x1, 0], [x1, 4], [x0, 4]],
      floor: "m", ceiling: "m", walls: { material: "m", ...(t ? { thickness: t } : {}) },
    });
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "a", at: [1, 1], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { o: { kind: "object", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [room("a", 0, 4), room("b", 4, 6, 0.4)],
      openings: [{ id: "d", kind: "arch", at: [4, 3], width: 0.9 }],
      props: [{ id: "p", asset: "o", cat: "vase", room: "a", at: [1.95, 2], size: { w: 0.3, d: 0.3, h: 0.5 }, face: "room", solid: false }],
    };
    const { report } = runCheck(raw, { until: "props" });
    expect(report.errors).toEqual([]);
    expect((report.passport.props as any[]).find((p) => p.id === "p").yaw).toBe(270);
  });

  test("test_hits_wall_depth_from_merged_face", () => {
    // the shared wall of a/b is 0.4 thick: its inner face in `a` is x = 3.8
    const room = (id: string, x0: number, x1: number, t?: number): any => ({
      id, level: "L0", height: 3, shape: [[x0, 0], [x1, 0], [x1, 4], [x0, 4]],
      floor: "m", ceiling: "m", walls: { material: "m", ...(t ? { thickness: t } : {}) },
    });
    const raw: any = {
      version: 0, name: "t",
      spawn: { room: "a", at: [1, 1], yaw: 0 },
      materials: { m: { color: "#ffffff" } }, assets: { o: { kind: "object", prompt: "x" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [room("a", 0, 4), room("b", 4, 6, 0.4)],
      openings: [{ id: "d", kind: "arch", at: [4, 3], width: 0.9 }],
      props: [{ id: "p", asset: "o", cat: "box", room: "a", at: [3.7, 1.5], size: { w: 0.4, d: 0.4, h: 0.5 }, yaw: 0 }],
    };
    const { report } = runCheck(raw, { until: "props" });
    const e = report.errors.find((x) => x.code === "PROP_HITS_WALL")!;
    expect(e.msg).toContain("0.1 м");
    expect(e.fix).toEqual({ at: [3.59, 1.5] });
  });

  test("test_mutual_face_targets_resolve", () => {
    const pr = (id: string, at: number[], face: string): any => ({ id, asset: "p_vase", cat: "vase", room: "living", at, size: { w: 0.2, d: 0.2, h: 0.3 }, face, solid: false });
    const { report } = runCheck(patched([
      { op: "add", path: "/props/-", value: pr("a", [2, 2], "b") },
      { op: "add", path: "/props/-", value: pr("b", [3, 2], "a") },
    ]), { until: "props" });
    const yaw = (id: string) => (report.passport.props as any[]).find((p) => p.id === id)?.yaw;
    expect([yaw("a"), yaw("b")]).toEqual([90, 270]);
  });

  test("test_top_of_face_point_on_resolved_support", () => {
    const cab = { id: "cab", asset: "p_vase", cat: "vase", room: "living", at: [-3.5, 1], size: { w: 0.8, d: 0.4, h: 0.3 }, mount: "wall", y: 1, solid: false };
    const first = runCheck(patched([{ op: "add", path: "/props/-", value: cab }]), { until: "props" });
    const c = (first.ctx.props as PropGeo[]).find((p) => p.id === "cab")!.obb.c;
    const { report } = runCheck(patched([
      { op: "add", path: "/props/-", value: cab },
      { op: "add", path: "/props/-", value: { id: "pot", asset: "p_vase", cat: "vase", room: "living", mount: { top_of: "cab" }, size: { w: 0.2, d: 0.2, h: 0.3 }, face: [c[0], c[1]], solid: false } },
    ]), { until: "props" });
    expect(report.errors.map((e) => [e.code, e.path])).toEqual([["POS_INVALID", "/props/6/face"]]);
  });

  test("test_wall_search_strict_limit", () => {
    // 0.9999995 m from living#0 is strictly closer than 1 m
    const { report } = runCheck(patched([
      { op: "add", path: "/props/-", value: { id: "cab", asset: "p_vase", cat: "vase", room: "living", at: [-3.0000005, 1], size: { w: 0.3, d: 0.2, h: 0.3 }, mount: "wall", y: 1.5, solid: false } },
    ]), { until: "props" });
    expect(report.errors.map((e) => e.code)).not.toContain("PROP_WALL_NOT_FOUND");
    expect((report.passport.props as any[]).some((p) => p.id === "cab")).toBe(true);
  });

  test("test_face_wall_prop_authored_at_not_final", () => {
    // `cab` is pulled from its authored [-3.5, 1] onto living#0, so a prop
    // standing at [-3.5, 1] can still face it
    const cab = { id: "cab", asset: "p_vase", cat: "vase", room: "living", at: [-3.5, 1], size: { w: 0.3, d: 0.28, h: 0.3 }, mount: "wall", y: 1.5, solid: false };
    const { report } = runCheck(patched([
      { op: "add", path: "/props/-", value: cab },
      { op: "add", path: "/props/-", value: { id: "pot", asset: "p_vase", cat: "vase", room: "living", at: [-3.5, 1], size: { w: 0.2, d: 0.2, h: 0.3 }, face: "cab", solid: false } },
    ]), { until: "props" });
    expect(report.errors).toEqual([]);
    expect((report.passport.props as any[]).find((p) => p.id === "pot").yaw).toBe(270);
  });

  const tiny = (rooms: any[], props: any[]): any => ({
    version: 0, name: "t",
    spawn: { room: rooms[0].id, at: [2, 1], yaw: 0 },
    materials: { m: { color: "#ffffff" } }, assets: { o: { kind: "object", prompt: "x" } },
    levels: [{ id: "L0", y: 0 }],
    rooms: rooms.map((r) => ({ level: "L0", height: 3, floor: "m", ceiling: "m", walls: { material: "m" }, ...r })),
    props,
  });
  const wallBox = (room: string, on: any): any => ({ id: "w", asset: "o", cat: "vase", room, on, mount: "wall", y: 1, size: { w: 0.4, d: 0.4, h: 0.4 }, solid: false });

  test("test_semicircle_endpoint_normal_inward", () => {
    // at a semicircle's end the radial is parallel to the chord: the sign must
    // still come from the arc's orientation, not from a zero dot product
    const raw = tiny([{ id: "r", shape: [[0, 3, { bulge: 1 }], [0, -3], [4, -3], [4, 3]] }], [wallBox("r", { room: "r", edge: 0, t: 0 })]);
    const { report } = runCheck(raw, { until: "props" });
    expect(report.errors).toEqual([]);
    const w = (report.passport.props as any[]).find((p) => p.id === "w");
    expect(w.yaw).toBe(180);
  });

  test("test_wall_prop_on_snapped_axis", () => {
    const raw = tiny([
      { id: "a", shape: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      { id: "b", shape: [[4.06, 0.06], [8, 0.06], [8, 4.06], [4.06, 4.06]] },
    ], [wallBox("b", { room: "b", edge: 0, t: 0.5 })]);
    raw.openings = [{ id: "d", kind: "arch", at: [4, 2], width: 0.9 }];
    const { ctx } = runCheck(raw, { until: "props" });
    const c = (ctx.props as PropGeo[]).find((p) => p.id === "w")!.obb.c;
    expect(c[1]).toBeCloseTo(0.06 + 0.02 + 0.2, 6);
  });

  test("test_face_room_on_snapped_axes", () => {
    // b's left wall snapped from x = 4.06 to the shared x = 4: the top wall is nearer
    const raw = tiny([
      { id: "a", shape: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      { id: "b", shape: [[4.06, 0.06], [8, 0.06], [8, 4.06], [4.06, 4.06]] },
    ], [{ id: "p", asset: "o", cat: "vase", room: "b", at: [6.02, 2.06], size: { w: 0.2, d: 0.2, h: 0.3 }, face: "room", solid: false }]);
    raw.openings = [{ id: "d", kind: "arch", at: [4, 2], width: 0.9 }];
    const { report } = runCheck(raw, { until: "props" });
    expect((report.passport.props as any[]).find((p) => p.id === "p").yaw).toBe(180);
  });

  test("test_wall_search_on_snapped_axis", () => {
    // b's left wall snapped from x = 4.06 to 4: [5.03, 2] is 1.03 m from it
    const raw = tiny([
      { id: "a", shape: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      { id: "b", shape: [[4.06, 0.06], [8, 0.06], [8, 4.06], [4.06, 4.06]] },
    ], [{ id: "w", asset: "o", cat: "vase", room: "b", at: [5.03, 2], mount: "wall", y: 1, size: { w: 0.4, d: 0.4, h: 0.4 }, solid: false }]);
    raw.openings = [{ id: "d", kind: "arch", at: [4, 3], width: 0.9 }];
    const { report } = runCheck(raw, { until: "props" });
    expect(report.errors.map((e) => e.code)).toEqual(["PROP_WALL_NOT_FOUND"]);
  });

  test("test_wall_prop_wider_than_tiny_circle_is_finite", () => {
    // the inner face of an r = 0.05 circle has no 0.2 m chord: report it, no NaN
    const raw = tiny([{ id: "r", circle: { c: [0, 0], r: 0.05 } }],
      [{ ...wallBox("r", { room: "r", edge: 0, t: 0 }), size: { w: 0.2, d: 0.1, h: 0.2 }, solid: true }]);
    raw.spawn = { room: "r", at: [0, 0], yaw: 0 };
    const { report } = runCheck(raw, { until: "props" });
    expect(JSON.stringify(report)).not.toMatch(/NaN|null\]/);
    expect(report.errors.map((e) => e.path)).toContain("/props/0/on");
  });
});

