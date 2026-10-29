import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Scene } from "../types.js";
import { normalizeGlb } from "../assets/glb.js";
import { resolvedAssets } from "../assets/run.js";
import type { AssetFiles } from "./geometry.js";

/** The normalized GLB's own bound, in metres, before the page's scale. */
export interface GlbSize {
  w: number;
  d: number;
  h: number;
}

/** Where each asset landed in `dist/`, plus the bound of every object asset. */
export interface PlacedAssets {
  files: AssetFiles;
  sizes: Record<string, GlbSize>;
}

/**
 * Copies every `used` asset out of the cache and next to the page, under the
 * id it's referenced by, so geometry.json can point at a stable
 * `assets/<id>.*` path instead of the cache's content-addressed one.
 *
 * Object assets go through `normalizeGlb` on the way out — front to +Z,
 * bottom on y = 0, footprint centred — so the page can place a mesh from
 * numbers Node computed instead of measuring the model itself.
 */
export function placeAssets(scene: Scene, cacheDir: string, used: string[], outDir: string): PlacedAssets {
  // a null-prototype map so an asset id of "__proto__" lands as a real own
  // key instead of silently hitting the inherited accessor (F5)
  const files: AssetFiles = Object.create(null) as AssetFiles;
  const sizes: Record<string, GlbSize> = Object.create(null) as Record<string, GlbSize>;
  const declared = ((scene as any)?.assets ?? {}) as Record<string, any>;

  const resolved = resolvedAssets(scene, cacheDir, used);
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
    if (r.kind === "object") {
      const out = normalizeGlb(readFileSync(r.path), Number(declared[r.id]?.front_deg ?? 0));
      writeFileSync(dest, out.glb);
      sizes[r.id] = out.size;
    } else {
      copyFileSync(r.path, dest);
    }
    files[r.id] = urlRel;
  }
  return { files, sizes };
}
