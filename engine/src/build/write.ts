import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import type { Ctx } from "../ctx.js";
import type { Report } from "../types.js";
import { buildGeometry, type AssetFiles } from "./geometry.js";
import { buildNav } from "../nav/grid.js";
import { topSvg } from "../report/topsvg.js";
import { indexHtml } from "./page.js";
import { runAssets, type AssetReport } from "../assets/run.js";
import { placeAssets, type GlbSize } from "./materials.js";

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

  // Each `used` asset's real file is copied next to the page, and every
  // object asset is normalized on the way so its placement is decided here,
  // in Node, not measured again in the browser.
  let assetFiles: AssetFiles = {};
  let glbSizes: Record<string, GlbSize> = {};
  if (opts.cacheDir !== undefined && assets.used.length > 0) {
    const placed = placeAssets(ctx.scene, opts.cacheDir, assets.used, outDir);
    assetFiles = placed.files;
    glbSizes = placed.sizes;
  }

  const geometry = buildGeometry(ctx, assetFiles, glbSizes);
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
