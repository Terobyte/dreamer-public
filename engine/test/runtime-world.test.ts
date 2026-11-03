import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture, type Object3D } from "three";
import { buildWorld, withBase, type WorldLoaders } from "../src/runtime/world.js";
import { EYE } from "../src/runtime/walk.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "../../h0/make/testdata/world_run/dist");
const read = (f: string): any => JSON.parse(readFileSync(join(DIST, f), "utf8"));
const data = (): { geo: any; nav: any; built: any } => ({ geo: read("geometry.json"), nav: read("nav.json"), built: read("build.json") });

/** a GLB stand-in: a Group with one child mesh, no DOM, no network */
const stubLoaders = (calls: string[] = [], fail: Set<string> = new Set()): WorldLoaders => ({
  maps: async () => new Map<string, Texture>(),
  glb: async (src: any) => {
    calls.push(src.glb);
    if (fail.has(src.glb)) throw new Error("boom");
    const g = new Group();
    g.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    return g;
  },
  scatter: async () => new Group(),
});

describe("buildWorld", () => {
  it("test_objects_has_every_mesh_id_also_after_glb_swap", async () => {
    const d = data();
    const w = await buildWorld(d, { base: "./", loaders: stubLoaders() });
    for (const m of d.geo.meshes) expect(w.objects.has(String(m.id)), m.id).toBe(true);
    expect(w.objects.get("living_sofa")!.type).toBe("Group"); // swapped
    expect(w.objects.get("living:floor")!.type).toBe("Mesh");
    expect(w.root.children).toContain(w.objects.get("living_sofa"));
    expect(w.loads.total).toBe(d.geo.meshes.filter((m: any) => typeof m.glb === "string").length);
    expect(w.loads.ok).toBe(w.loads.total);
    expect(w.loads.failed).toBe(0);
  });

  it("test_shell_is_only_floor_wall_cap", async () => {
    const w = await buildWorld(data(), { base: "./", loaders: stubLoaders() });
    expect(w.shell.length).toBeGreaterThan(0);
    for (const o of w.shell) expect(["floor", "wall", "cap"]).toContain(o.userData.kind);
    const want = (w.geo.meshes as any[]).filter((m) => ["floor", "wall", "cap"].includes(m.kind)).length;
    expect(w.shell.length).toBe(want);
    expect(w.root.children.some((o: Object3D) => (o as any).isLight)).toBe(true); // lights live in root, outside shell
    expect(w.shell.some((o) => (o as any).isLight)).toBe(false);
  });

  it("test_glb_failure_keeps_placeholder_and_counts", async () => {
    const w = await buildWorld(data(), { base: "./", loaders: stubLoaders([], new Set(["./assets/p_sofa.glb"])) });
    expect(w.objects.get("living_sofa")!.type).toBe("Mesh");
    expect(w.root.children).toContain(w.objects.get("living_sofa"));
    expect(w.loads.failed).toBe(1);
    expect(w.loads.ok + w.loads.failed).toBe(w.loads.total);
  });

  it("test_hide_visible_and_swap_keeps_visibility_and_kind", async () => {
    const d = data();
    const w = await buildWorld(d, { base: "", hide: new Set(["prop", "ceiling"]), loaders: stubLoaders() });
    expect(w.objects.get("living:ceiling")!.visible).toBe(false);
    expect(w.objects.get("living_sofa")!.visible).toBe(false);
    expect(w.objects.get("living_sofa")!.userData.kind).toBe("prop");
    expect(w.objects.get("living:floor")!.visible).toBe(true);
  });

  it("test_base_prefixes_glb_urls", async () => {
    const calls: string[] = [];
    await buildWorld(data(), { base: "./worlds/x/", loaders: stubLoaders(calls) });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.startsWith("./worlds/x/assets/")).toBe(true);
  });

  it("test_spawn_matches_walker_start", async () => {
    const d = data();
    const w = await buildWorld(d, { base: "./", loaders: stubLoaders() });
    const p = w.walker.pos();
    expect(w.spawn.x).toBeCloseTo(p[0], 6);
    expect(w.spawn.z).toBeCloseTo(p[2], 6);
    expect(w.spawn.floorY + EYE).toBeCloseTo(p[1], 6);
    expect(w.spawn.yawDeg).toBe(d.geo.spawn.yaw);
  });

  it("test_no_renderer_no_dom_and_style_defaults", async () => {
    const w = await buildWorld(data(), { base: "./", loaders: stubLoaders() });
    expect(typeof document).toBe("undefined");
    expect(w.style.exterior).toBe("#8a8a80");
    expect(w.style.tone).toBe(true);
    expect(w.style.exposure).toBeCloseTo(0.9, 6);
    expect(w.shadows).toBe(false);
    expect(w.background).toBeNull();
    expect(w.doors.has("door1")).toBe(true);
    expect(w.layers.length).toBe(1);
  });

  it("test_empty_built_and_no_layers", async () => {
    const d = data();
    const w = await buildWorld({ geo: d.geo, nav: { ...d.nav, layers: [], doors: {} } }, { base: "./", loaders: stubLoaders() });
    expect(w.doors.size).toBe(0);
    expect(w.layers.length).toBe(1);
    expect(w.built).toEqual({});
  });

  it("test_plant_noblock_survives_glb_swap", async () => {
    const d = data();
    const base = d.geo.meshes[0] as any;
    const plant = {
      id: "meadow_grass_tuft",
      kind: "prop",
      material: base.material,
      positions: base.positions,
      normals: base.normals,
      uvs: base.uvs,
      indices: base.indices,
      glb: "./assets/p_sofa.glb",
    };
    const geo = { ...d.geo, meshes: [...d.geo.meshes, plant] };
    const w = await buildWorld({ geo, nav: d.nav, built: d.built }, { base: "./", loaders: stubLoaders() });
    const obj = w.objects.get("meadow_grass_tuft")!;
    expect(obj).toBeDefined();
    expect(obj.userData.noblock).toBe(true);
    // child meshes of the swapped GLB keep the flag too
    let childNoblock = false;
    obj.traverse((o: any) => { if (o.isMesh) childNoblock = o.userData.noblock === true; });
    expect(childNoblock).toBe(true);
    expect(obj.type).toBe("Group");
  });

  it("test_sun_shadows_flag_glb_and_scatter_meshes", async () => {
    const d = data();
    const geo: any = {
      ...d.geo,
      lights: [{ kind: "sun", dir: [0.3, 1, 0.2], intensity: 1, castShadow: true }],
      scatter: [{ i: 0, asset: "test_grass", glb: "./assets/scatter.glb", count: 1, transforms: [[0, 0, 0, 0, 1]] }],
    };
    const stub: WorldLoaders = {
      maps: async () => new Map<string, Texture>(),
      glb: async () => {
        const g = new Group();
        g.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
        return g;
      },
      scatter: async () => {
        const g = new Group();
        g.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
        return g;
      },
    };
    const w = await buildWorld({ geo, nav: d.nav, built: d.built }, { base: "./", loaders: stub });
    expect(w.shadows).toBe(true);
    // every mesh in the swapped GLB has shadows
    const sofa = w.objects.get("living_sofa")!;
    sofa.traverse((o: any) => { if (o.isMesh) { expect(o.castShadow).toBe(true); expect(o.receiveShadow).toBe(true); } });
    // scatter InstancedMesh also has shadows
    const scatter = w.root.children.find((c) => c.name === "scatter")!;
    expect(scatter).toBeDefined();
    scatter.traverse((o: any) => { if (o.isMesh) { expect(o.castShadow).toBe(true); expect(o.receiveShadow).toBe(true); } });
  });

  it("test_scatter_in_root_not_in_objects_or_shell_and_counted_in_loads", async () => {
    const d = data();
    const geo: any = {
      ...d.geo,
      scatter: [{ i: 0, asset: "my_asset", glb: "./assets/a.glb", count: 2, transforms: [[0,0,0,0,1],[1,0,1,0,1]] }],
    };
    const calls: string[] = [];
    const stub: WorldLoaders = {
      maps: async () => new Map<string, Texture>(),
      glb: async (src: any) => {
        calls.push(src.glb);
        const g = new Group(); g.add(new Mesh(new BoxGeometry(1,1,1), new MeshBasicMaterial())); return g;
      },
      scatter: async (url: string) => {
        calls.push(url);
        const g = new Group(); g.add(new Mesh(new BoxGeometry(1,1,1), new MeshBasicMaterial())); return g;
      },
    };
    const meshGlbs = (d.geo.meshes as any[]).filter((m) => typeof m.glb === "string").length;
    const w = await buildWorld({ geo, nav: d.nav, built: d.built }, { base: "./worlds/x/", loaders: stub });
    // scatter group lives in root
    const scatter = w.root.children.find((c) => c.name === "scatter");
    expect(scatter).toBeDefined();
    expect(w.root.children).toContain(scatter!);
    // scatter is not in objects or shell
    expect(w.objects.has("my_asset")).toBe(false);
    for (const id of (d.geo.meshes as any[]).map((m: any) => String(m.id))) expect(w.objects.has(id)).toBe(true);
    expect(w.shell.some((o) => o.name === "scatter" || o.parent?.name === "scatter")).toBe(false);
    // loads counts both mesh GLBs and scatter GLBs
    expect(w.loads.total).toBe(meshGlbs + 1);
    expect(w.loads.ok).toBe(w.loads.total);
    expect(calls.some((c) => c.includes("./worlds/x/assets/a.glb"))).toBe(true);
  });

  it("test_withBase_prefixes_relative_and_skips_absolute", () => {
    expect(withBase("./worlds/x", "assets/foo.glb")).toBe("./worlds/x/assets/foo.glb");
    expect(withBase("./worlds/x/", "assets/foo.glb")).toBe("./worlds/x/assets/foo.glb");
    expect(withBase("./worlds/x", "./assets/foo.glb")).toBe("./worlds/x/assets/foo.glb");
    expect(withBase("./worlds/x/", "https://example.com/a.glb")).toBe("https://example.com/a.glb");
    expect(withBase("./worlds/x/", "/absolute.glb")).toBe("/absolute.glb");
    expect(withBase("", "assets/foo.glb")).toBe("assets/foo.glb");
  });
});
