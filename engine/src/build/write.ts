import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import type { Ctx } from "../ctx.js";
import type { Report } from "../types.js";
import { buildGeometry, type AssetFiles, type Camera } from "./geometry.js";
import { buildNav } from "../nav/grid.js";
import { topSvg } from "../report/topsvg.js";
import { indexHtml } from "./page.js";
import { resolvedAssets, runAssets, sceneAssets, type AssetReport, type AssetWarning } from "../assets/run.js";
import { placeAssets, type GlbSize } from "./materials.js";
import { factOf, type PropFact } from "../props/fact.js";
import type { Geometry } from "./geometry.js";
import { glbTriangles } from "../assets/tris.js";
import { TRI_LIMITS, propClass, type TriCount } from "../budget.js";
import { cutGlb } from "../assets/cut.js";
import { shotBaseNames } from "./shotnames.js";
import { doorDefs, type DoorJson } from "./doors.js";
import { floorDecals } from "./decals.js";
import { remount, surfacesOf, worldSurfaces, type Surface, type WorldSurface } from "./surfaces.js";

export interface BuildJson {
  ok: boolean;
  seconds: number;
  /** `cut`: object assets whose cached mesh was over budget and went into dist cut down */
  /** `pose`: per used object asset, the pose SAM3D gave a mesh cut by mask (`null` when none); not used for placement */
  assets: {
    used: string[];
    fallback: string[];
    missing: string[];
    cut?: Record<string, { from: number; to: number }>;
    pose?: Record<string, object | null>;
  };
  /** what each prop's model really measures, so `check --built` can use it */
  props: Record<string, { fact: PropFact | null; at?: [number, number] }>;
  /** floor decals (`at` + `rotation`): a plane facing up on the room's floor + 0.005 */
  decals: { i: number; room: string; asset: string; center: [number, number, number]; normal: [number, number, number]; size: { w: number; h: number }; rotation: number }[];
  /** `scatter`: one entry per asset, `transforms` = `[x, y, z, yaw, scale]` per copy */
  scatter: NonNullable<Geometry["scatter"]>;
  /** every scene light as the page gets it; a `sun` is one directional light */
  lights: Geometry["lights"];
  /** horizontal surfaces of every placed model by mesh id (world system); `[]` when none were found */
  surfaces: Record<string, WorldSurface[]>;
  warnings: string[];
  /** triangles of the built scene: engine geometry plus every placed model */
  tris: TriCount;
  /** door openings with a leaf: the page turns them around `hinge_at` */
  doors: DoorJson[];
}

/**
 * The measured bound of every prop: the normalized GLB's own box times the
 * scale its mesh was fitted with. A prop left as a placeholder has no model
 * to measure, so its fact is `null` and `check` falls back to the author's
 * `size`. Copies of an `around` prop share one asset and one size, so the
 * first mesh of the group answers for the whole prop.
 */
/**
 * A built mesh id is either the prop's own id or an `around` copy (`<id>.<k>`):
 * match it back to the author's id, so a dotted id like `vase.small` survives
 * instead of being cut to `vase` (F6). Without a known id only a trailing
 * numeric copy suffix is stripped.
 */
function rawPropId(meshId: string, propIds: Set<string>): string {
  if (propIds.has(meshId)) return meshId;
  let best: string | null = null;
  for (const id of propIds) {
    if (meshId.startsWith(`${id}.`) && (best === null || id.length > best.length)) best = id;
  }
  if (best !== null) return best;
  return meshId.replace(/\.\d+$/, "");
}

export function propFacts(
  scene: any,
  geometry: Geometry,
  glbSizes: Record<string, GlbSize>,
  moved: Record<string, [number, number]> = {},
): BuildJson["props"] {
  const propIds = new Set(((scene?.props ?? []) as any[]).map((r) => String(r?.id)));
  const scaleOf = new Map<string, number>();
  const scaleYOf = new Map<string, number>();
  for (const m of geometry.meshes as any[]) {
    if (m.kind !== "prop" || m.glb === undefined || typeof m.scale !== "number") continue;
    const id = rawPropId(String(m.id), propIds);
    if (!scaleOf.has(id)) {
      scaleOf.set(id, m.scale);
      if (typeof m.scaleY === "number") scaleYOf.set(id, m.scaleY);
    }
  }
  // no prototype: an id literally named "__proto__" must stay an own key
  const out: BuildJson["props"] = Object.create(null);
  for (const raw of (scene?.props ?? []) as any[]) {
    const id = String(raw?.id);
    const glb = glbSizes[String(raw?.asset)];
    const scale = scaleOf.get(id);
    out[id] = {
      fact: glb !== undefined && scale !== undefined ? { ...factOf(glb, scale), h: glb.h * (scaleYOf.get(id) ?? scale) } : null,
      // where the prop stands after `--apply-fixes` moved it
      ...(Object.prototype.hasOwnProperty.call(moved, id) ? { at: moved[id] } : {}),
    };
  }
  return out;
}

/**
 * Triangles of the dist/: engine meshes by their index count, a prop mesh with
 * a model by that model's own count (once per copy). `by_prop` is one copy.
 */
export function countTris(geometry: Geometry, outDir: string, propIds?: Iterable<string>): TriCount {
  const perFile = new Map<string, number | null>();
  const unreadable: string[] = [];
  const modelTris = (rel: string): number | null => {
    let n = perFile.get(rel);
    if (n === undefined) {
      try {
        n = glbTriangles(readFileSync(join(outDir, decodeURIComponent(rel))));
      } catch {
        n = null;
      }
      perFile.set(rel, n);
    }
    return n;
  };
  let total = 0;
  // no prototype: an id literally named "__proto__" must stay an own key (F7)
  const by_prop: Record<string, number> = Object.create(null);
  const ids = new Set(propIds ?? []);
  for (const m of geometry.meshes) {
    if (m.kind === "prop" && m.glb !== undefined) {
      const n = modelTris(m.glb);
      const key = rawPropId(String(m.id), ids);
      if (n === null) {
        if (!unreadable.includes(key)) unreadable.push(key);
        continue;
      }
      total += n;
      if (!Object.prototype.hasOwnProperty.call(by_prop, key)) by_prop[key] = n;
    } else {
      total += Math.floor(m.indices.length / 3);
    }
  }
  return unreadable.length > 0 ? { total, by_prop, unreadable } : { total, by_prop };
}

const RUNTIME_ENTRY = fileURLToPath(new URL("../runtime/main.ts", import.meta.url));

/**
 * Node-side `.js` specifiers point at the `.ts` sources the repo ships, so
 * the bundler needs the same rewrite tsx does at run time.
 */
const tsExtensions = {
  name: "ts-ext",
  setup(b: any): void {
    b.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (a: any) => {
      const abs = resolve(dirname(a.importer), a.path);
      const ts = abs.replace(/\.js$/, ".ts");
      return existsSync(ts) ? { path: ts } : null;
    });
  },
};

export async function bundleRuntime(outFile: string): Promise<void> {
  await esbuild({
    entryPoints: [RUNTIME_ENTRY],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    plugins: [tsExtensions as never],
    logLevel: "silent",
  });
}

/**
 * Camera refs live next to the scene, which `dist/` must not depend on: each
 * one is copied into `dist/refs/<i>-<basename>` and the geometry points there,
 * so `dreamer shots` can build the sheet out of `dist/` alone. A ref that is
 * not on disk is downgraded to `null` with a warning, never an error: the shot
 * is still worth taking, it just has no pair on the sheet.
 */
function copyRefs(cameras: Camera[], outDir: string, scenePath?: string): string[] {
  const warnings: string[] = [];
  const shotNames = shotBaseNames(cameras);
  cameras.forEach((cam, i) => {
    const ref = cam.ref;
    if (ref === undefined || ref === null) return;
    const src = scenePath === undefined ? ref : resolve(dirname(scenePath), ref);
    if (!existsSync(src) || !statSync(src).isFile()) {
      cam.ref = null;
      warnings.push(`cameras: no ref file for camera ${cam.id} at ${ref}, the sheet row has no pair`);
      return;
    }
    const rel = join("refs", `${i}-${basename(ref)}`);
    mkdirSync(join(outDir, "refs"), { recursive: true });
    copyFileSync(src, join(outDir, rel));
    cam.ref = rel.split(sep).join("/");
    // the ref also sits next to the shot it will be compared with
    mkdirSync(join(outDir, "shots"), { recursive: true });
    copyFileSync(src, join(outDir, "shots", `${shotNames[i]}.ref${extname(ref).toLowerCase() || ".png"}`));
  });
  return warnings;
}

/**
 * The cache keeps every mesh in full; the budget is applied here, on the
 * copy in dist. One GLB serves every prop that uses it, so the strictest
 * prop's limit wins.
 */
async function cutPlaced(
  ctx: Ctx,
  outDir: string,
  objects: string[],
  warnings: string[],
): Promise<Record<string, { from: number; to: number }>> {
  const cut: Record<string, { from: number; to: number }> = Object.create(null);
  const props = ((ctx.scene as any)?.props ?? []) as any[];
  for (const id of objects) {
    const limits = props.filter((p) => String(p?.asset) === id && p?.size).map((p) => TRI_LIMITS[propClass(p.size)]);
    if (limits.length === 0) continue;
    const limit = Math.min(...limits);
    const dest = join(outDir, "assets", `${id}.glb`);
    const buf = readFileSync(dest);
    const from = glbTriangles(buf);
    if (from <= limit) continue;
    try {
      const out = await cutGlb(buf, limit);
      writeFileSync(dest, out);
      cut[id] = { from, to: glbTriangles(out) };
    } catch (e) {
      warnings.push(`ASSET_CUT_FAILED ${id}: ${(e as Error).message}`);
    }
  }
  return cut;
}

/**
 * Surfaces of every prop mesh with a model, read from the file that ends up in
 * dist (after the budget cut). An asset `placeAssets` rejected has no size and
 * no key here; one with no surface, or a file the reader refuses, gets `[]`
 * and a `SURFACES_EMPTY <id>` warning.
 */
function meshSurfaces(
  geometry: Geometry,
  outDir: string,
  assetFiles: AssetFiles,
  glbSizes: Record<string, GlbSize>,
  warnings: string[],
): Record<string, WorldSurface[]> {
  const out: Record<string, WorldSurface[]> = Object.create(null);
  const placed = new Set(Object.keys(glbSizes).map((id) => assetFiles[id]));
  const cache = new Map<string, Surface[]>();
  for (const m of geometry.meshes as any[]) {
    if (m.kind !== "prop" || typeof m.glb !== "string" || !placed.has(m.glb)) continue;
    let local = cache.get(m.glb);
    if (local === undefined) {
      try {
        local = surfacesOf(readFileSync(join(outDir, decodeURIComponent(m.glb))));
      } catch {
        local = [];
      }
      cache.set(m.glb, local);
    }
    const world = worldSurfaces(local, m);
    out[String(m.id)] = world;
    if (world.length === 0) warnings.push(`SURFACES_EMPTY ${m.id}`);
  }
  return out;
}

/** Each used object's `<key>.pose.json` next to its GLB in the cache; a missing or unreadable file is `null`. */
function posesOf(ctx: Ctx, cacheDir: string | undefined, used: string[], scenePath: string | undefined): Record<string, object | null> {
  const out: Record<string, object | null> = Object.create(null);
  if (cacheDir === undefined) {
    // No cache, no pose files: a used object still gets its explicit null.
    const kinds = new Map(sceneAssets(ctx.scene).map((r) => [r.id, r.kind]));
    for (const id of used) if (kinds.get(id) === "object") out[id] = null;
    return out;
  }
  const sceneDir = scenePath === undefined ? undefined : dirname(scenePath);
  for (const a of resolvedAssets(ctx.scene, cacheDir, used, sceneDir)) {
    if (a.kind !== "object") continue;
    const file = a.path.replace(/\.glb$/, ".pose.json");
    let pose: object | null = null;
    try {
      if (existsSync(file)) {
        const v = JSON.parse(readFileSync(file, "utf-8"));
        pose = v !== null && typeof v === "object" ? v : null;
      }
    } catch {
      pose = null;
    }
    out[a.id] = pose;
  }
  return out;
}

function warningText(w: AssetWarning): string {
  if (w.code === "REF_IGNORED") return `${w.code}: ${w.id} drawn from its prompt, the provider has no fromRef`;
  if (w.code === "MASK_ALL_FALLBACK") return `${w.code}: no object went through the mask, every one took the redraw path`;
  if (w.reason === undefined) return `${w.code}: ${w.id} SAM3D failed after the mask, no redraw fallback`;
  return `${w.code}: ${w.id} cut by redraw, the mask path gave ${w.reason}`;
}

/** Everything `build` puts in `dist/`; the scene's own directory is untouched. */
export async function writeDist(
  ctx: Ctx,
  report: Report,
  outDir: string,
  opts: { startedAt: number; assets?: AssetReport; cacheDir?: string; scenePath?: string; fixes?: string[]; moved?: Record<string, [number, number]> },
): Promise<BuildJson> {
  // Assets the cache could not provide stay coloured placeholders, and the
  // build says so instead of failing: a half-generated world is still walkable.
  const assets = opts.assets ?? (await runAssets(ctx.scene, { mode: "none" }));

  // Each `used` asset's real file is copied next to the page, and every
  // object asset is normalized on the way so its placement is decided here,
  // in Node, not measured again in the browser.
  let assetFiles: AssetFiles = {};
  let glbSizes: Record<string, GlbSize> = {};
  const assetWarnings: string[] = [];
  if (opts.cacheDir !== undefined && assets.used.length > 0) {
    const placed = placeAssets(ctx.scene, opts.cacheDir, assets.used, outDir, opts.scenePath === undefined ? undefined : dirname(opts.scenePath));
    assetFiles = placed.files;
    glbSizes = placed.sizes;
    assetWarnings.push(...placed.warnings);
  }
  const cut = await cutPlaced(ctx, outDir, Object.keys(glbSizes), assetWarnings);

  const built = buildGeometry(ctx, assetFiles, glbSizes);
  const nav = ctx.nav ?? buildNav(ctx);
  const surfaceWarnings: string[] = [];
  const surfaces = meshSurfaces(built, outDir, assetFiles, glbSizes, surfaceWarnings);
  // props on a model with surfaces go onto the real surface; `surfaces` shifts with them
  const mounted = remount(built, ctx.scene, surfaces);
  const geometry = mounted.geometry as Geometry;
  surfaceWarnings.push(...mounted.warnings);
  mkdirSync(outDir, { recursive: true });
  const refWarnings = copyRefs(geometry.cameras, outDir, opts.scenePath);
  writeFileSync(join(outDir, "check.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "top.svg"), topSvg(ctx));
  writeFileSync(join(outDir, "nav.json"), JSON.stringify(nav));
  writeFileSync(join(outDir, "geometry.json"), JSON.stringify(geometry));
  writeFileSync(join(outDir, "index.html"), indexHtml(String((ctx.scene as any)?.name ?? "scene")));
  await bundleRuntime(join(outDir, "runtime.js"));

  const out: BuildJson = {
    ok: true,
    seconds: (Date.now() - opts.startedAt) / 1000,
    assets: {
      used: assets.used,
      fallback: assets.fallback,
      missing: assets.missing,
      ...(Object.keys(cut).length > 0 ? { cut } : {}),
      pose: posesOf(ctx, opts.cacheDir, assets.used, opts.scenePath),
    },
    props: propFacts(ctx.scene, geometry, glbSizes, opts.moved),
    doors: doorDefs(ctx),
    decals: floorDecals(ctx).map((d) => ({ i: d.i, room: d.room, asset: d.asset, center: d.center, normal: d.normal, size: d.size, rotation: d.rotation })),
    scatter: geometry.scatter ?? [],
    lights: geometry.lights,
    tris: countTris(
      geometry,
      outDir,
      ((ctx.scene as any)?.props ?? []).map((r: any) => String(r?.id)),
    ),
    surfaces,
    warnings: [
      ...assetWarnings,
      ...surfaceWarnings,
      ...(geometry.scatterWarnings ?? []),
      ...report.warnings.map((w) => `${w.code}: ${w.msg}`),
      // a generated asset its post-step rejected (a sky that is not 2:1)
      ...(assets.failed ?? []).map((w) => `${w.code}: ${w.msg}`),
      // an object with a ref the provider could not use: drawn from text, said out loud
      ...(assets.warnings ?? []).map(warningText),
      ...assets.missing.map((id) => `assets: no cached asset for ${id}, drawing a placeholder`),
      ...refWarnings,
      ...(opts.fixes ?? []),
    ],
  };
  writeFileSync(join(outDir, "build.json"), JSON.stringify(out, null, 2));
  return out;
}
