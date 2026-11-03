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

  // X2 contract: host must not allocate in update() and package script must guard XR exit / sessionActive
  it("xr_host_no_alloc_in_update_and_package_guards", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const host = readFileSync(join(root, "app/src/engine-host.ts"), "utf8");
    // F4: no toFixed / template that allocates per frame inside update()
    const updateBlock = host.slice(host.indexOf("update()"));
    expect(updateBlock.includes("toFixed")).toBe(false);
    const pkg = JSON.parse(readFileSync(join(root, "app/package.json"), "utf8"));
    const script: string = pkg.scripts["xr:check"] ?? "";
    // F1: xr exit must run even if browser run fails — no bare && chain before exit
    // detect pattern "&& iwsdk xr exit" which skips on failure
    expect(script.includes("&& iwsdk xr exit")).toBe(false);
    const runnerContent = readFileSync(join(root, "app/tools/xr-check-runner.mjs"), "utf8");
    expect(runnerContent.includes("xr exit")).toBe(true);
    // F2: sessionActive must be checked in runner (not via comment in package.json)
    expect(runnerContent.includes("sessionActive")).toBe(true);
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    // F5: single rule
    const count = (gi.match(/app\/public\/worlds\//g) ?? []).length;
    expect(count).toBe(1);
    const fmap = readFileSync(join(root, "research/feature_map_xr.md"), "utf8");
    // F3: map mentions pickWorld and xr-check
    expect(fmap.includes("pickWorld")).toBe(true);
    expect(fmap.includes("xr-check")).toBe(true);
  });

  // F9/F10: runner must treat signal termination and xr exit failures as errors.
  // Behavioral: a fake `iwsdk` on PATH plays each failure; the real runner must exit non-zero
  // and still try `xr exit`.
  it("xr_check_runner_handles_signal_and_exit_error", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { fileURLToPath } = await import("node:url");
    const { spawnSync } = await import("node:child_process");
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const runner = join(root, "app/tools/xr-check-runner.mjs");
    const dir = mkdtempSync(join(tmpdir(), "xrcheck-"));
    const fake = join(dir, "iwsdk");
    writeFileSync(fake, [
      "#!/bin/sh",
      'echo "$*" >> "$XR_LOG"',
      'case "$*" in',
      '  "runtime status") echo \'{"data":{"result":{"browser":{"lifecycle":{"state":"running"},"status":"connected"}}}}\' ;;',
      '  "browser run"*) [ "$XR_MODE" = signal ] && kill -TERM $$; printf \'{\\n"data":{"result":{"code":0}}}\\n\' ;;',
      '  "xr status") echo \'{"sessionActive": true}\' ;;',
      '  "xr exit") [ "$XR_MODE" = exitfail ] && exit 7; [ "$XR_MODE" = exitsignal ] && kill -TERM $$ ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(fake, 0o755);
    const play = (mode: string) => {
      const log = join(dir, `${mode}.log`);
      writeFileSync(log, "");
      const r = spawnSync(process.execPath, [runner], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, XR_MODE: mode, XR_LOG: log },
        encoding: "utf8",
        timeout: 30_000,
      });
      return { code: r.status, calls: readFileSync(log, "utf8") };
    };
    try {
      const ok = play("ok");
      expect(ok.code).toBe(0); // the fake is a passing run: failures below are the runner's doing
      for (const mode of ["signal", "exitfail", "exitsignal"]) {
        const r = play(mode);
        expect(r.code, mode).not.toBe(0);
        expect(r.calls, mode).toContain("xr exit");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // RED test X2 contract: strict checks that fail before fix (F16, F11, F14) — behavioral for missing __dreamerXr
  it("xr_host_strict_contract_red", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const host = readFileSync(join(root, "app/src/engine-host.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(join(root, "app/package.json"), "utf8"));
    const script: string = pkg.scripts["xr:check"] ?? "";
    const runner = readFileSync(join(root, "app/tools/xr-check-runner.mjs"), "utf8");
    const checker = readFileSync(join(root, "app/tools/xr-check.mjs"), "utf8");
    // F11: package.json must not cheat via comment — script itself must be clean
    expect(script.includes("#")).toBe(false);
    // runner must contain real sessionActive guard, not via package.json comment
    expect(runner.includes("sessionActive")).toBe(true);
    expect(runner.includes("finally")).toBe(true);
    // checker must handle missing __dreamerXr with timeout code 2
    expect(checker.includes("no __dreamerXr")).toBe(true);
    expect(checker.includes("TIMEOUT_MS") || checker.includes("60_000")).toBe(true);
    // behavioral: actually run checker against a page with no report -> code 2
    const { default: run } = await import("../../app/tools/xr-check.mjs");
    let evalCount = 0;
    const target = {
      isDetached: () => false,
      evaluate: async (fn: any) => {
        evalCount++;
        if (evalCount === 1) return [false, null];
        if (evalCount === 2) return undefined;
        return null;
      },
    };
    const page: any = {
      $: async () => null,
      mainFrame: () => target,
      reload: async () => {},
    };
    const origNow = Date.now;
    const origSetTimeout = global.setTimeout;
    let now = 0;
    (Date as any).now = () => now;
    (global as any).setTimeout = (cb: any, ms: number) => {
      now += ms + 1;
      cb();
      return 1 as any;
    };
    try {
      const res: any = await run({ page, frame: target });
      expect(res.code).toBe(2);
      expect(res.reason).toMatch(/no __dreamerXr|timeout/);
    } finally {
      (Date as any).now = origNow;
      (global as any).setTimeout = origSetTimeout;
    }
    // F16: report.player must be read from world.player.position, not spawn copy
    expect(host.includes("world.player.position")).toBe(true);
    // F14: update() must not allocate via throwing probe.teleport — use non-throwing check
    const upd = host.slice(host.indexOf("update()"));
    expect(upd.includes("throw") || upd.includes("Error(")).toBe(false);
    expect(upd.includes("probe.teleport")).toBe(false);
  });

  it("xr_host_no_rollback_no_alloc", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const host = readFileSync(join(root, "app/src/engine-host.ts"), "utf8");
    const upd = host.slice(host.indexOf("update()"));
    // X3: страж только считает offNav, не откатывает (иначе дрожание F8) — 0 вызовов setPlayerPosition из update
    expect(upd.includes("setPlayerPosition")).toBe(false);
    // В update нельзя выделять: rampUnder возвращает новый объект и аллоцирует, floorAtRooms аллоцирует массив
    expect(upd.includes("rampUnder")).toBe(false);
    expect(upd.includes("floorAtRooms")).toBe(false);
    // также не должно быть создания массивов/объектов в update (isWalkable как helper с аллокацией вынесен)
    // дополнительно: отчет должен обновляться без toFixed
    expect(upd.includes("toFixed")).toBe(false);
  });
});
