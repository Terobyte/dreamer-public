import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Scene } from "../types.js";
import { cachePaths, cacheKey } from "./cache.js";
import { cutWhite } from "./alpha.js";
import type { AssetKind } from "./templates.js";
import type { ImageProvider, ObjectProvider } from "./providers/types.js";

export type AssetsMode = "none" | "cache" | "live";

export interface AssetRef {
  id: string;
  kind: AssetKind;
  prompt: string;
  aspect: string;
  key: string;
}

export interface AssetReport {
  used: string[];
  fallback: string[];
  missing: string[];
  cents: number;
}

export interface AssetsOpts {
  mode: AssetsMode;
  cacheDir?: string;
  image?: ImageProvider;
  object?: ObjectProvider;
  maxDollars?: number;
}

/**
 * Every asset the scene actually points at, in `assets` declaration order.
 * A declared-but-unreferenced asset costs money for nothing, so it is never
 * generated and never shows up in the report.
 */
export function sceneAssets(scene: Scene): AssetRef[] {
  const declared = (scene?.assets ?? {}) as Record<string, any>;
  const referenced = new Set<string>();
  const want = (id: unknown): void => {
    if (typeof id === "string") referenced.add(id);
  };
  for (const m of Object.values((scene?.materials ?? {}) as Record<string, any>)) want(m?.tile);
  for (const p of (scene?.props ?? []) as any[]) want(p?.asset);
  for (const d of (scene?.decals ?? []) as any[]) want(d?.asset);
  for (const o of (scene?.openings ?? []) as any[]) {
    want(o?.leaf?.decal);
    want(o?.outside?.backdrop);
  }
  const refs: AssetRef[] = [];
  for (const [id, a] of Object.entries(declared)) {
    if (!referenced.has(id)) continue;
    const kind = a?.kind as AssetKind;
    const prompt = String(a?.prompt ?? "");
    const aspect = typeof a?.aspect === "string" ? a.aspect : "1:1";
    refs.push({ id, kind, prompt, aspect, key: cacheKey(kind, prompt, aspect) });
  }
  return refs;
}

/** True once the asset has everything the page needs to draw it for real. */
function cached(cacheDir: string, ref: AssetRef): boolean {
  const p = cachePaths(cacheDir, ref.key);
  return existsSync(ref.kind === "object" ? p.glb : p.png);
}

/**
 * Brings the scene's assets in. `none` touches nothing — every asset stays a
 * coloured placeholder. `cache` reads only: an asset the cache does not have
 * is reported `missing` and drawn as a placeholder instead of failing the
 * build, because a half-generated world is still walkable.
 */
export async function runAssets(scene: Scene, opts: AssetsOpts): Promise<AssetReport> {
  const refs = sceneAssets(scene);
  if (opts.mode === "none") {
    return { used: [], fallback: refs.map((r) => r.id), missing: [], cents: 0 };
  }
  if (opts.mode === "live") throw new Error("assets: live not implemented");
  const cacheDir = opts.cacheDir;
  if (cacheDir === undefined) throw new Error("assets: cache mode needs a cache directory");

  const used: string[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    if (!cached(cacheDir, ref)) {
      missing.push(ref.id);
      continue;
    }
    if (ref.kind === "decal") ensureAlpha(cacheDir, ref);
    used.push(ref.id);
  }
  return { used, fallback: missing.slice(), missing, cents: 0 };
}

export interface ResolvedAsset {
  id: string;
  kind: AssetKind;
  /** Absolute path to the file `dist/assets` should be given for this id. */
  path: string;
}

/** Where each `used` asset's real file lives in the cache, for `writeDist` to copy out. */
export function resolvedAssets(scene: Scene, cacheDir: string, used: string[]): ResolvedAsset[] {
  const byId = new Map(sceneAssets(scene).map((r) => [r.id, r]));
  const out: ResolvedAsset[] = [];
  for (const id of used) {
    const ref = byId.get(id);
    if (ref === undefined) continue;
    const p = cachePaths(cacheDir, ref.key);
    out.push({ id, kind: ref.kind, path: ref.kind === "object" ? p.glb : ref.kind === "decal" ? p.alpha : p.png });
  }
  return out;
}

/** The cut is deterministic, so it is derived once and then cached next to the source. */
function ensureAlpha(cacheDir: string, ref: AssetRef): void {
  const p = cachePaths(cacheDir, ref.key);
  if (existsSync(p.alpha)) return;
  writeFileSync(p.alpha, cutWhite(readFileSync(p.png)));
}
