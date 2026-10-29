import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import type { Ctx } from "../ctx.js";
import type { Report } from "../types.js";
import { buildGeometry, type AssetFiles } from "./geometry.js";
import { buildNav } from "../nav/grid.js";
import { topSvg } from "../report/topsvg.js";
import { indexHtml } from "./page.js";
import { runAssets, resolvedAssets, type AssetReport } from "../assets/run.js";

export interface BuildJson {
  ok: boolean;
  seconds: number;
  assets: { used: string[]; fallback: string[]; missing: string[] };
  warnings: string[];
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

/** Everything `build` puts in `dist/`; the scene's own directory is untouched. */
export async function writeDist(
  ctx: Ctx,
  report: Report,
  outDir: string,
  opts: { startedAt: number; assets?: AssetReport; cacheDir?: string },
): Promise<BuildJson> {
  // Assets the cache could not provide stay coloured placeholders, and the
  // build says so instead of failing: a half-generated world is still walkable.
  const assets = opts.assets ?? (await runAssets(ctx.scene, { mode: "none" }));

  // Each `used` asset's real file is copied next to the page, under the id
  // it's referenced by, so geometry.json can point at a stable `assets/<id>.*`
  // path instead of the cache's content-addressed one.
  // a null-prototype map so an asset id of "__proto__" lands as a real own
  // key instead of silently hitting the inherited accessor (F5)
  const assetFiles: AssetFiles = Object.create(null) as AssetFiles;
  if (opts.cacheDir !== undefined && assets.used.length > 0) {
    const resolved = resolvedAssets(ctx.scene, opts.cacheDir, assets.used);
    const assetsDir = resolve(join(outDir, "assets"));
    if (resolved.length > 0) mkdirSync(assetsDir, { recursive: true });
    for (const r of resolved) {
      const ext = r.kind === "object" ? "glb" : "png";
      const rel = `assets/${r.id}.${ext}`;
      const dest = resolve(join(outDir, rel));
      // the page fetches `rel` as a URL, so each path segment is encoded on
      // its own: an id like "tile#custom" must not let "#custom" be read as
      // a fragment instead of part of the request path
      const urlRel = rel
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      // an asset id is a free-form scene author string, not a path (F4):
      // reject anything that would land outside dist/assets
      if (dest !== assetsDir && !dest.startsWith(assetsDir + sep)) {
        throw new Error(`asset id escapes the assets directory: ${r.id}`);
      }
      // an asset id may contain "/" (e.g. "tile/custom"), landing the copy
      // under a subdirectory of dist/assets that does not exist yet
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(r.path, dest);
      assetFiles[r.id] = urlRel;
    }
  }

  const geometry = buildGeometry(ctx, assetFiles);
  const nav = ctx.nav ?? buildNav(ctx);
  mkdirSync(outDir, { recursive: true });
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
    warnings: [
      ...report.warnings.map((w) => `${w.code}: ${w.msg}`),
      ...assets.missing.map((id) => `assets: no cached asset for ${id}, drawing a placeholder`),
    ],
  };
  writeFileSync(join(outDir, "build.json"), JSON.stringify(out, null, 2));
  return out;
}
