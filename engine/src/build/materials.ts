import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
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
  /** `ASSET_BLANK <id>` / `ASSET_GLB_BROKEN <id>` lines for `build.json` */
  warnings: string[];
}

/** A texture this flat carries no detail: the sheet would show a colour field. */
const BLANK_SHARE = 0.98;

/**
 * True when nearly every pixel is the same colour — the shape a failed or
 * refused generation takes. It is a warning, not an error: the page still
 * draws the tile, the author just has nothing to look at.
 */
function blankPng(buf: Buffer): boolean {
  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch {
    return false;
  }
  const counts = new Map<number, number>();
  const n = png.width * png.height;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // alpha counts too: identical RGB with varying opacity is still a
    // texture with detail, not a flat colour field
    const key =
      (png.data[o] << 24) | (png.data[o + 1] << 16) | (png.data[o + 2] << 8) | png.data[o + 3];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let top = 0;
  for (const c of counts.values()) top = Math.max(top, c);
  return top / n > BLANK_SHARE;
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
export function placeAssets(scene: Scene, cacheDir: string, used: string[], outDir: string, sceneDir?: string): PlacedAssets {
  // a null-prototype map so an asset id of "__proto__" lands as a real own
  // key instead of silently hitting the inherited accessor (F5)
  const files: AssetFiles = Object.create(null) as AssetFiles;
  const sizes: Record<string, GlbSize> = Object.create(null) as Record<string, GlbSize>;
  const declared = ((scene as any)?.assets ?? {}) as Record<string, any>;

  const warnings: string[] = [];
  const resolved = resolvedAssets(scene, cacheDir, used, sceneDir);
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
      // a GLB that will not parse leaves the prop a placeholder box instead
      // of killing the build: one bad mesh must not cost the whole world
      let out;
      try {
        out = normalizeGlb(readFileSync(r.path), Number(declared[r.id]?.front_deg ?? 0), {
          foliage: declared[r.id]?.foliage === true,
        });
      } catch {
        warnings.push(`ASSET_GLB_BROKEN ${r.id}`);
        continue;
      }
      // a model with no height cannot be fitted to the prop's `h` (the fit
      // scale would be infinite), so it is as unusable as one that would not
      // parse: same warning, same fall back to the OBB placeholder
      if (!(out.size.h > 0)) {
        warnings.push(`ASSET_GLB_BROKEN ${r.id}`);
        continue;
      }
      writeFileSync(dest, out.glb);
      sizes[r.id] = out.size;
    } else {
      const buf = readFileSync(r.path);
      if (blankPng(buf)) warnings.push(`ASSET_BLANK ${r.id}`);
      copyFileSync(r.path, dest);
    }
    files[r.id] = urlRel;
  }
  return { files, sizes, warnings };
}
