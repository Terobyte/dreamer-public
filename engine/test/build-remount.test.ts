import { describe, it, expect } from "vitest";
import { runCheck } from "../src/check.js";
import { demoFlat, patched } from "./helpers/scene.js";
import { remount } from "../src/build/surfaces.js";
import { worldSurfaces, type Surface, type WorldSurface } from "../src/build/surfaces.js";

const C = 0.05;

/** cells block [i0,i0+ni) x [j0,j0+nj) of a model whose origin is `origin` */
function surf(y: number, i0: number, j0: number, ni: number, nj: number, origin: [number, number], skip?: (i: number, j: number) => boolean): Surface {
  const cells: [number, number][] = [];
  for (let i = i0; i < i0 + ni; i++) for (let j = j0; j < j0 + nj; j++) if (!skip?.(i, j)) cells.push([i, j]);
  const is = cells.map((c) => c[0]);
  const js = cells.map((c) => c[1]);
  return {
    y,
    rect: [origin[0] + Math.min(...is) * C, origin[1] + Math.min(...js) * C, origin[0] + (Math.max(...is) + 1) * C, origin[1] + (Math.max(...js) + 1) * C],
    area: cells.length * C * C,
    open: true,
    origin,
    cells,
  };
}

function box(id: string, pos: [number, number, number], h = 0.2, yaw = 0): any {
  const [x, y, z] = pos;
  const h2 = 0.1;
  const positions: number[] = [];
  for (const dy of [0, h]) for (const dx of [-h2, h2]) for (const dz of [-h2, h2]) positions.push(x + dx, y + dy, z + dz);
  return { id, kind: "prop", material: "m", positions, normals: [], uvs: [], indices: [], glb: `${id}.glb`, glbPos: [x, y, z], glbYaw: yaw };
}

const geo = (meshes: any[]): any => ({ meshes });
const mesh = (g: any, id: string): any => g.meshes.find((m: any) => m.id === id);
const minY = (m: any): number => Math.min(...m.positions.filter((_: number, i: number) => i % 3 === 1));

function bedWorld(): { bed: any; surfaces: Record<string, WorldSurface[]> } {
  const bed = box("bed", [3, 0, 2]);
  const origin: [number, number] = [-0.8, -1.0];
  const local = [surf(0.45, 0, 0, 32, 40, origin), surf(0.75, 0, 0, 2, 2, origin)];
  return { bed, surfaces: { bed: worldSurfaces(local, bed) } };
}

describe("remount", () => {
  it("top_of on a bed lands on the mattress (0.45), not on the box top", () => {
    const { bed, surfaces } = bedWorld();
    const lamp = box("lamp", [3, 0.75, 2]);
    const scene: any = { props: [{ id: "bed" }, { id: "lamp", at: [3, 2], mount: { top_of: "bed" } }] };
    const r = remount(geo([bed, lamp]), scene, surfaces);
    expect(minY(mesh(r.geometry, "lamp"))).toBeCloseTo(0.45, 5);
    expect(mesh(r.geometry, "lamp").glbPos[1]).toBeCloseTo(0.45, 5);
    expect(r.warnings).toContain("REMOUNT lamp -0.300");
  });

  it("tier_of 1 lands on the second tier inside its rect", () => {
    const shelf = box("shelf", [1, 0, 1]);
    const origin: [number, number] = [-0.5, -0.2];
    const local = [0.1, 0.6, 1.1].map((y) => surf(y, 0, 0, 20, 8, origin));
    const surfaces = { shelf: worldSurfaces(local, shelf) };
    const book = box("book", [1, 0, 1]);
    const scene: any = { props: [{ id: "shelf" }, { id: "book", at: [1, 1], mount: { tier_of: "shelf", tier: 1 } }] };
    const r = remount(geo([shelf, book]), scene, surfaces);
    const m = mesh(r.geometry, "book");
    expect(m.glbPos[1]).toBeCloseTo(0.6, 5);
    expect(r.warnings.some((w) => w.startsWith("TIER_MISSING"))).toBe(false);
    const tier1 = surfaces.shelf.find((s) => Math.abs(s.y - 0.6) < 1e-5)!;
    const [bx, , bz] = m.glbPos;
    expect(bx).toBeGreaterThanOrEqual(tier1.rect[0]);
    expect(bx).toBeLessThanOrEqual(tier1.rect[2]);
    expect(bz).toBeGreaterThanOrEqual(tier1.rect[1]);
    expect(bz).toBeLessThanOrEqual(tier1.rect[3]);
    const cellI = Math.floor((bx - shelf.glbPos[0] - tier1.origin[0]) / C);
    const cellJ = Math.floor((bz - shelf.glbPos[2] - tier1.origin[1]) / C);
    expect(tier1.cells.some((c) => c[0] === cellI && c[1] === cellJ)).toBe(true);
  });

  it("tier 9 -> TIER_MISSING and the highest open surface like top_of", () => {
    const shelf = box("shelf", [1, 0, 1]);
    const origin: [number, number] = [-0.5, -0.2];
    const surfaces = { shelf: worldSurfaces([0.1, 0.6].map((y) => surf(y, 0, 0, 20, 8, origin)), shelf) };
    const book = box("book", [1, 1.6, 1]);
    const scene: any = { props: [{ id: "shelf" }, { id: "book", at: [1, 1], mount: { tier_of: "shelf", tier: 9 } }] };
    const r = remount(geo([shelf, book]), scene, surfaces);
    expect(r.warnings).toContain("TIER_MISSING book");
    expect(mesh(r.geometry, "book").glbPos[1]).toBeCloseTo(0.6, 5);
  });

  it("an at outside the surface moves glbPos and positions by one and the same delta", () => {
    const { bed, surfaces } = bedWorld();
    const lamp = box("lamp", [5, 0.75, 2]);
    const before = [...lamp.positions];
    const scene: any = { props: [{ id: "bed" }, { id: "lamp", at: [5, 2], mount: { top_of: "bed" } }] };
    const r = remount(geo([bed, lamp]), scene, surfaces);
    const m = mesh(r.geometry, "lamp");
    const d = [m.glbPos[0] - 5, m.glbPos[1] - 0.75, m.glbPos[2] - 2];
    expect(Math.abs(d[0]) + Math.abs(d[2])).toBeGreaterThan(0.5);
    for (let k = 0; k < before.length; k++) expect(m.positions[k] - before[k]).toBeCloseTo(d[k % 3], 5);
  });

  it("bed turned 45 deg: at inside the axis rect but outside the cells counts as outside", () => {
    const bed = box("bed", [0, 0, 0], 0.2, Math.PI / 4);
    const origin: [number, number] = [-0.8, -1.0];
    const surfaces = { bed: worldSurfaces([surf(0.45, 0, 0, 32, 40, origin)], bed) };
    const ws = surfaces.bed[0];
    const at: [number, number] = [ws.rect[2] - 0.05, ws.rect[3] - 0.05];
    const lamp = box("lamp", [at[0], 0.75, at[1]]);
    const scene: any = { props: [{ id: "bed" }, { id: "lamp", at, mount: { top_of: "bed" } }] };
    const r = remount(geo([bed, lamp]), scene, surfaces);
    const m = mesh(r.geometry, "lamp");
    expect(Math.hypot(m.glbPos[0] - at[0], m.glbPos[2] - at[1])).toBeGreaterThan(0.1);
    const c = Math.cos(Math.PI / 4);
    const s = Math.sin(Math.PI / 4);
    const sx = m.glbPos[0] * c - m.glbPos[2] * s;
    const sz = m.glbPos[0] * s + m.glbPos[2] * c;
    expect(sx).toBeGreaterThanOrEqual(-0.8 - 1e-6);
    expect(sx).toBeLessThanOrEqual(0.8 + 1e-6);
    expect(sz).toBeGreaterThanOrEqual(-1 - 1e-6);
    expect(sz).toBeLessThanOrEqual(1 + 1e-6);
  });

  it("L-shaped table, at in the cut-out: moved to the centre of the nearest cell", () => {
    const table = box("table", [0, 0, 0]);
    const origin: [number, number] = [0, 0];
    const cut = (i: number, j: number): boolean => i >= 10 && j >= 10;
    const surfaces = { table: worldSurfaces([surf(0.7, 0, 0, 20, 20, origin, cut)], table) };
    const cup = box("cup", [0.7, 0.9, 0.7]);
    const scene: any = { props: [{ id: "table" }, { id: "cup", at: [0.7, 0.7], mount: { top_of: "table" } }] };
    const r = remount(geo([table, cup]), scene, surfaces);
    const m = mesh(r.geometry, "cup");
    // nearest covered cells are (9,10..) / (10..,9); equal distance -> smaller i then j: (9,10)? ties go to the smaller i
    const i = Math.floor(m.glbPos[0] / C);
    const j = Math.floor(m.glbPos[2] / C);
    expect(cut(i, j)).toBe(false);
    expect((m.glbPos[0] / C) % 1).toBeCloseTo(0.5, 5);
    expect(Math.hypot(m.glbPos[0] - 0.7, m.glbPos[2] - 0.7)).toBeLessThan(0.3);
  });

  it("tier_of with at in a cut-out of the tier moves into the tier's cells", () => {
    const shelf = box("shelf", [0, 0, 0]);
    const origin: [number, number] = [0, 0];
    const cut = (i: number, j: number): boolean => i >= 10 && j >= 10;
    const surfaces = { shelf: worldSurfaces([surf(0.3, 0, 0, 20, 20, origin), surf(0.9, 0, 0, 20, 20, origin, cut)], shelf) };
    const book = box("book", [0.7, 0.9, 0.7]);
    const scene: any = { props: [{ id: "shelf" }, { id: "book", at: [0.7, 0.7], mount: { tier_of: "shelf", tier: 1 } }] };
    const r = remount(geo([shelf, book]), scene, surfaces);
    const m = mesh(r.geometry, "book");
    expect(m.glbPos[1]).toBeCloseTo(0.9, 5);
    expect(cut(Math.floor(m.glbPos[0] / C), Math.floor(m.glbPos[2] / C))).toBe(false);
  });

  it("chain: lamp top_of book, book tier_of shelf, shelf declared last and moved", () => {
    const base = box("base", [1, 0, 1]);
    const shelf = box("shelf", [1, 0.5, 1]);
    const bo: [number, number] = [-0.5, -0.2];
    const surfaces: Record<string, WorldSurface[]> = {
      base: worldSurfaces([surf(0.4, 0, 0, 20, 20, [-0.5, -0.5])], base),
      shelf: worldSurfaces([surf(0.1, 0, 0, 20, 8, bo), surf(0.6, 0, 0, 20, 8, bo)], shelf),
      book: worldSurfaces([surf(0.05, 0, 0, 4, 4, [-0.1, -0.1])], box("book", [1, 1.1, 1])),
    };
    const book = box("book", [1, 1.1, 1]);
    const lamp = box("lamp", [1, 1.15, 1]);
    const scene: any = {
      props: [
        { id: "lamp", at: [1, 1], mount: { top_of: "book" } },
        { id: "book", at: [1, 1], mount: { tier_of: "shelf", tier: 1 } },
        { id: "base" },
        { id: "shelf", at: [1, 1], mount: { top_of: "base" } },
      ],
    };
    // shelf 0.5 -> 0.4 (-0.1); its tier 1 is at 1.0 now; book 1.1 -> 1.0; the book's top 1.05; lamp 1.15 -> 1.05
    const r = remount(geo([lamp, book, base, shelf]), scene, surfaces);
    expect(mesh(r.geometry, "shelf").glbPos[1]).toBeCloseTo(0.4, 5);
    expect(mesh(r.geometry, "book").glbPos[1]).toBeCloseTo(1.0, 5);
    expect(mesh(r.geometry, "lamp").glbPos[1]).toBeCloseTo(1.05, 5);
  });

  it("no surfaces for the support: nothing moves, no warnings", () => {
    const base = box("base", [1, 0, 1]);
    const cup = box("cup", [1, 0.2, 1]);
    const scene: any = { props: [{ id: "base" }, { id: "cup", at: [1, 1], mount: { top_of: "base" } }] };
    const r = remount(geo([base, cup]), scene, {});
    expect(mesh(r.geometry, "cup").glbPos).toEqual([1, 0.2, 1]);
    expect(r.warnings).toEqual([]);
  });

  it("remounts around-copies using the source prop mount", () => {
    const { bed, surfaces } = bedWorld();
    const cup0 = box("cup.0", [3, 0.75, 2]);
    const cup1 = box("cup.1", [3.2, 0.75, 2]);
    const scene: any = { props: [{ id: "bed" }, { id: "cup", around: { target: "bed" }, mount: { top_of: "bed" } }] };
    const r = remount(geo([bed, cup0, cup1]), scene, surfaces);
    expect(mesh(r.geometry, "cup.0").glbPos[1]).toBeCloseTo(0.45, 5);
    expect(mesh(r.geometry, "cup.1").glbPos[1]).toBeCloseTo(0.45, 5);
    expect(r.warnings).toContain("REMOUNT cup.0 -0.300");
    expect(r.warnings).toContain("REMOUNT cup.1 -0.300");
  });
});

const pot = (mount: unknown, extra: object = {}): any => ({
  id: "pot", asset: "p_vase", cat: "vase", room: "living", mount, size: { w: 0.2, d: 0.2, h: 0.3 }, face: "room", solid: false, ...extra,
});
const add = (v: unknown): any => [{ op: "add", path: "/props/-", value: v }];
const checkOf = (v: unknown, until: "schema" | "props" = "schema"): any => runCheck(patched(add(v)), { until });
const codes = (r: any): string[] => [...r.report.errors, ...r.report.warnings].map((i: any) => `${i.code} ${i.path}`);

describe("tier_of in the scene", () => {
  it("schema takes {tier_of, tier: 1} without at; rejects no tier, 1.5, -1", () => {
    expect(checkOf(pot({ tier_of: "table", tier: 1 })).report.errors).toEqual([]);
    for (const bad of [{ tier_of: "table" }, { tier_of: "table", tier: 1.5 }, { tier_of: "table", tier: -1 }]) {
      expect(checkOf(pot(bad)).report.errors.length).toBeGreaterThan(0);
    }
    // exercises posOf in refs.ts: face aiming directly at the support centre is POS_INVALID, aiming elsewhere is valid
    const flat = demoFlat() as any;
    const table = flat.props.find((p: any) => p.id === "table");
    const sameAt = checkOf(pot({ tier_of: "table", tier: 1 }, { face: table.at }));
    expect(sameAt.report.errors.some((e: any) => e.code === "POS_INVALID" && e.path.endsWith("/face"))).toBe(true);
    const diffAt = checkOf(pot({ tier_of: "table", tier: 1 }, { face: [table.at[0] + 1, table.at[1]] }));
    expect(diffAt.report.errors.some((e: any) => e.code === "POS_INVALID")).toBe(false);
  });

  it("unknown support and a cycle are reference errors like top_of", () => {
    const r = checkOf(pot({ tier_of: "nope", tier: 0 }));
    const t = checkOf(pot({ top_of: "nope" }));
    expect(r.report.errors.map((e: any) => e.code)).toEqual(t.report.errors.map((e: any) => e.code));
    expect(r.report.errors.some((e: any) => e.code === "REF_UNKNOWN" && e.path === "/props/5/mount/tier_of")).toBe(true);
    const s = demoFlat() as any;
    s.props[0].mount = { tier_of: "sofa", tier: 0 };
    s.props[2].mount = { top_of: "table" };
    const { report } = runCheck(s, { until: "schema" });
    const refs = report.errors.filter((e) => e.code === "REF_UNKNOWN");
    expect(refs.length).toBe(1);
    expect(refs[0].msg).toContain("цикл");
  });

  it("placeProps and the linter treat tier_of like top_of", () => {
    const a = checkOf(pot({ tier_of: "table", tier: 0 }), "props");
    const b = checkOf(pot({ top_of: "table" }), "props");
    const y = (r: any): unknown => (r.report.passport.props as any[]).find((p) => p.id === "pot")?.y;
    expect(y(a)).toBeDefined();
    expect(y(a)).toEqual(y(b));
    expect(codes(a)).toEqual(codes(b).map((c) => c));
    const a2 = checkOf(pot({ tier_of: "nope", tier: 0 }), "props");
    const b2 = checkOf(pot({ top_of: "nope" }), "props");
    expect(codes(a2).map((c) => c.split(" ")[0])).toEqual(codes(b2).map((c) => c.split(" ")[0]));

    // support declared later in scene.props: tier-mounted prop placed before its support table
    const beforeTier = runCheck(patched([{ op: "add", path: "/props/0", value: pot({ tier_of: "table", tier: 0 }) }]), { until: "props" });
    const beforeTop = runCheck(patched([{ op: "add", path: "/props/0", value: pot({ top_of: "table" }) }]), { until: "props" });
    expect(y(beforeTier)).toBeDefined();
    expect(y(beforeTier)).toEqual(y(beforeTop));
    expect(codes(beforeTier)).toEqual(codes(beforeTop));
  });
});
