import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import type { Ctx } from "../ctx.js";
import type { Report } from "../types.js";
import { buildGeometry } from "./geometry.js";
import { buildNav } from "../nav/grid.js";
import { topSvg } from "../report/topsvg.js";
import { indexHtml } from "./page.js";

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
  opts: { startedAt: number },
): Promise<BuildJson> {
  const geometry = buildGeometry(ctx);
  const nav = ctx.nav ?? buildNav(ctx);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "check.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "top.svg"), topSvg(ctx));
  writeFileSync(join(outDir, "nav.json"), JSON.stringify(nav));
  writeFileSync(join(outDir, "geometry.json"), JSON.stringify(geometry));
  writeFileSync(join(outDir, "index.html"), indexHtml(String((ctx.scene as any)?.name ?? "scene")));
  await bundleRuntime(join(outDir, "runtime.js"));

  // phase 2 draws every asset a mesh actually refers to as a placeholder;
  // declared-but-unused assets never reach the geometry, so they fall out.
  // A mesh's `material` is either an asset id directly (props, decals) or a
  // scene material id that points at a tile asset (`materials.*.tile`).
  const assets = (ctx.scene as any)?.assets ?? {};
  const sceneMaterials = (ctx.scene as any)?.materials ?? {};
  const usedAssets = new Set<string>();
  for (const m of geometry.meshes) {
    if (Object.prototype.hasOwnProperty.call(assets, m.material)) usedAssets.add(m.material);
    const tile = sceneMaterials[m.material]?.tile;
    if (typeof tile === "string") usedAssets.add(tile);
  }
  const fallback = Object.keys(assets as Record<string, unknown>).filter((id) => usedAssets.has(id));
  const out: BuildJson = {
    ok: true,
    seconds: (Date.now() - opts.startedAt) / 1000,
    assets: { used: [], fallback, missing: [] },
    warnings: report.warnings.map((w) => `${w.code}: ${w.msg}`),
  };
  writeFileSync(join(outDir, "build.json"), JSON.stringify(out, null, 2));
  return out;
}
