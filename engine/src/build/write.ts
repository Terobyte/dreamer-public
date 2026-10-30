import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import type { Ctx } from "../ctx.js";
import type { Report } from "../types.js";
import { buildGeometry, type AssetFiles, type Camera } from "./geometry.js";
import { buildNav } from "../nav/grid.js";
import { topSvg } from "../report/topsvg.js";
import { indexHtml } from "./page.js";
import { runAssets, type AssetReport } from "../assets/run.js";
import { placeAssets, type GlbSize } from "./materials.js";
import { factOf, type PropFact } from "../props/fact.js";
import type { Geometry } from "./geometry.js";
import { glbTriangles } from "../assets/tris.js";
import type { TriCount } from "../budget.js";

export interface BuildJson {
  ok: boolean;
  seconds: number;
  assets: { used: string[]; fallback: string[]; missing: string[] };
  /** what each prop's model really measures, so `check --built` can use it */
  props: Record<string, { fact: PropFact | null }>;
  warnings: string[];
  /** triangles of the built scene: engine geometry plus every placed model */
  tris: TriCount;
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

function propFacts(scene: any, geometry: Geometry, glbSizes: Record<string, GlbSize>): BuildJson["props"] {
  const propIds = new Set(((scene?.props ?? []) as any[]).map((r) => String(r?.id)));
  const scaleOf = new Map<string, number>();
  for (const m of geometry.meshes as any[]) {
    if (m.kind !== "prop" || m.glb === undefined || typeof m.scale !== "number") continue;
    const id = rawPropId(String(m.id), propIds);
    if (!scaleOf.has(id)) scaleOf.set(id, m.scale);
  }
  // no prototype: an id literally named "__proto__" must stay an own key
  const out: BuildJson["props"] = Object.create(null);
  for (const raw of (scene?.props ?? []) as any[]) {
    const id = String(raw?.id);
    const glb = glbSizes[String(raw?.asset)];
    const scale = scaleOf.get(id);
    out[id] = { fact: glb !== undefined && scale !== undefined ? factOf(glb, scale) : null };
  }
  return out;
}

/**
 * Triangles of the dist/: engine meshes by their index count, a prop mesh with
 * a model by that model's own count (once per copy). `by_prop` is one copy.
 */
export function countTris(geometry: Geometry, outDir: string, propIds?: Iterable<string>): TriCount {
  const perFile = new Map<string, number>();
  const modelTris = (rel: string): number => {
    let n = perFile.get(rel);
    if (n === undefined) {
      try {
        n = glbTriangles(readFileSync(join(outDir, decodeURIComponent(rel))));
      } catch {
        n = 0;
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
      total += n;
      const key = rawPropId(String(m.id), ids);
      if (!Object.prototype.hasOwnProperty.call(by_prop, key)) by_prop[key] = n;
    } else {
      total += Math.floor(m.indices.length / 3);
    }
  }
  return { total, by_prop };
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
  cameras.forEach((cam, i) => {
    const ref = cam.ref;
    if (ref === undefined) return;
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
  });
  return warnings;
}

/** Everything `build` puts in `dist/`; the scene's own directory is untouched. */
export async function writeDist(
  ctx: Ctx,
  report: Report,
  outDir: string,
  opts: { startedAt: number; assets?: AssetReport; cacheDir?: string; scenePath?: string },
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
    const placed = placeAssets(ctx.scene, opts.cacheDir, assets.used, outDir);
    assetFiles = placed.files;
    glbSizes = placed.sizes;
    assetWarnings.push(...placed.warnings);
  }

  const geometry = buildGeometry(ctx, assetFiles, glbSizes);
  const nav = ctx.nav ?? buildNav(ctx);
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
    assets: { used: assets.used, fallback: assets.fallback, missing: assets.missing },
    props: propFacts(ctx.scene, geometry, glbSizes),
    tris: countTris(
      geometry,
      outDir,
      ((ctx.scene as any)?.props ?? []).map((r: any) => String(r?.id)),
    ),
    warnings: [
      ...assetWarnings,
      ...report.warnings.map((w) => `${w.code}: ${w.msg}`),
      ...assets.missing.map((id) => `assets: no cached asset for ${id}, drawing a placeholder`),
      ...refWarnings,
    ],
  };
  writeFileSync(join(outDir, "build.json"), JSON.stringify(out, null, 2));
  return out;
}
