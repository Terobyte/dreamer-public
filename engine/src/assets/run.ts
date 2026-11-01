import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Scene } from "../types.js";
import { cachePaths, cacheKey, appendLedger } from "./cache.js";
import { cutWhite } from "./alpha.js";
import { inpaintSky, seamSky } from "./sky.js";
import type { Issue } from "../types.js";
import { type AssetKind, promptFor, sizeFor } from "./templates.js";
import { Budget, CapError, IMAGE_CENTS, MESH_CENTS, dollarsToCents } from "./cost.js";
import { IMAGE_CONCURRENCY, pool } from "./batch.js";
import { RetryableError } from "./providers/muse-image.js";
import type { ImageProvider, ObjectProvider } from "./providers/types.js";

export type AssetsMode = "none" | "cache" | "live";

export interface AssetRef {
  id: string;
  kind: AssetKind;
  prompt: string;
  aspect: string;
  key: string;
  /** object only: the picture bytes (read from the scene folder) and what to cut out; already in `key` */
  ref?: { bytes: Buffer; what: string };
  /** why the declared `ref` could not be read: the asset is not generated and goes to `failed` */
  refError?: "REF_PATH" | "REF_MISSING";
}

/** A failed asset: `reason` and `id` say which one and why (a ref outside the scene folder, say). */
export type AssetFailure = Issue & { reason?: string; id?: string };

export interface AssetReport {
  used: string[];
  fallback: string[];
  missing: string[];
  cents: number;
  /** assets generated but rejected by a post-step (a sky that is not 2:1), or whose `ref` could not be read */
  failed?: AssetFailure[];
  /** `REF_IGNORED`: an object with a `ref` drawn from text because the provider has no `fromRef` */
  warnings?: { code: "REF_IGNORED"; id: string }[];
}

export interface AssetsOpts {
  mode: AssetsMode;
  cacheDir?: string;
  image?: ImageProvider;
  object?: ObjectProvider;
  maxDollars?: number;
  /** the folder of `scene.json`: every `ref.image` is read relative to it, never outside */
  sceneDir?: string;
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
  want((scene as any)?.outdoor?.sky);
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

/**
 * True when `full` lies strictly inside `root`. A `relative` check stays exact
 * at `/` (where `root + sep` becomes `//`) and names only whole components, so
 * a file called `..foo` is not mistaken for its parent.
 */
function inside(root: string, full: string): boolean {
  const rel = relative(root, full);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Reads each object's `ref.image` from `sceneDir` and folds the bytes into its
 * key. An absolute path or one that leaves `sceneDir` after normalization is
 * never read (`REF_PATH`); a file that is not there is `REF_MISSING`. A symlink
 * inside the folder pointing outside it resolves outside and is `REF_PATH` too.
 */
function withRefs(scene: Scene, refs: AssetRef[], sceneDir: string | undefined): AssetRef[] {
  const declared = (scene?.assets ?? {}) as Record<string, any>;
  return refs.map((r) => {
    const want = declared[r.id]?.ref;
    if (r.kind !== "object" || want === undefined || want === null) return r;
    const image = String(want.image ?? "");
    const what = String(want.what ?? "");
    if (sceneDir === undefined) return { ...r, refError: "REF_MISSING" };
    const root = resolve(sceneDir);
    const full = resolve(root, image);
    if (image === "" || isAbsolute(image) || !inside(root, full)) return { ...r, refError: "REF_PATH" };
    let real: string;
    try {
      if (!existsSync(full) || !statSync(full).isFile()) return { ...r, refError: "REF_MISSING" };
      real = realpathSync(full);
    } catch {
      return { ...r, refError: "REF_MISSING" };
    }
    try {
      if (!inside(realpathSync(root), real)) return { ...r, refError: "REF_PATH" };
    } catch {
      return { ...r, refError: "REF_PATH" };
    }
    const ref = { bytes: readFileSync(real), what };
    return { ...r, ref, key: cacheKey(r.kind, r.prompt, r.aspect, ref) };
  });
}

function refFailure(r: AssetRef): AssetFailure {
  const path = `/assets/${r.id}/ref`;
  const why = r.refError === "REF_PATH" ? "path leaves the scene folder" : "no such file in the scene folder";
  return {
    code: r.refError as any,
    stage: "assets" as any,
    path,
    msg: `assets: ref image of ${r.id}: ${why}, drawing a placeholder`,
    reason: r.refError,
    id: r.id,
  };
}

/** True once the asset has everything the page needs to draw it for real. */
function cached(cacheDir: string, ref: AssetRef): boolean {
  const p = cachePaths(cacheDir, ref.key);
  return existsSync(ref.kind === "object" ? p.glb : p.png);
}

/**
 * The scene's assets the cache does not already have. Callers use this to
 * decide whether live providers (and their API key) are needed at all —
 * a fully populated cache should build without touching either.
 */
export function missingAssets(scene: Scene, cacheDir: string, sceneDir?: string): AssetRef[] {
  return withRefs(scene, sceneAssets(scene), sceneDir).filter((r) => r.refError === undefined && !cached(cacheDir, r));
}

/**
 * What a `todo` asset still costs: an object whose reference image is
 * already cached (only its mesh failed before) only costs the mesh.
 */
function remainingCents(cacheDir: string, ref: AssetRef): number {
  // a sky may pay a second image call: the edit that paints its seam band
  if (ref.kind === "sky") return 2 * IMAGE_CENTS;
  if (ref.kind !== "object") return IMAGE_CENTS;
  const hasSrc = existsSync(cachePaths(cacheDir, ref.key).src);
  return (hasSrc ? 0 : IMAGE_CENTS) + MESH_CENTS;
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
  const all = withRefs(scene, refs, opts.sceneDir);
  const bad = all.filter((r) => r.refError !== undefined);
  const report = await runReadable(scene, all.filter((r) => r.refError === undefined), opts);
  if (bad.length === 0) return report;
  return {
    ...report,
    fallback: [...report.fallback, ...bad.map((r) => r.id)],
    failed: [...(report.failed ?? []), ...bad.map(refFailure)],
  };
}

async function runReadable(scene: Scene, refs: AssetRef[], opts: AssetsOpts): Promise<AssetReport> {
  if (opts.mode === "live") return await runLive(scene, refs, opts);
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
export function resolvedAssets(scene: Scene, cacheDir: string, used: string[], sceneDir?: string): ResolvedAsset[] {
  const byId = new Map(withRefs(scene, sceneAssets(scene), sceneDir).map((r) => [r.id, r]));
  const out: ResolvedAsset[] = [];
  for (const id of used) {
    const ref = byId.get(id);
    if (ref === undefined) continue;
    const p = cachePaths(cacheDir, ref.key);
    out.push({ id, kind: ref.kind, path: ref.kind === "object" ? p.glb : ref.kind === "decal" ? p.alpha : p.png });
  }
  return out;
}

/**
 * Writes `data` to `path`, never leaving a partial file behind: a mid-write
 * failure (disk full, say) can leave a truncated file at `path` under the
 * same name `cached()` checks, which would otherwise make the asset look
 * done. Any leftover is removed before the failure propagates.
 */
function writeCached(path: string, data: Buffer): void {
  try {
    writeFileSync(path, data);
  } catch (e) {
    try {
      unlinkSync(path);
    } catch {
      // Nothing to clean up if the failure happened before any bytes landed.
    }
    throw e;
  }
}

/** The cut is deterministic, so it is derived once and then cached next to the source. */
function ensureAlpha(cacheDir: string, ref: AssetRef): void {
  const p = cachePaths(cacheDir, ref.key);
  if (existsSync(p.alpha)) return;
  writeFileSync(p.alpha, cutWhite(readFileSync(p.png)));
}

/**
 * Generates whatever the cache is missing. The cap is checked twice: once for
 * the whole batch before a single call is made, and again before every
 * attempt — so a retry that no longer fits simply leaves the asset `missing`
 * instead of overspending. One asset failing never stops the others.
 */
async function runLive(scene: Scene, refs: AssetRef[], opts: AssetsOpts): Promise<AssetReport> {
  const cacheDir = opts.cacheDir;
  if (cacheDir === undefined) throw new Error("assets: live mode needs a cache directory");
  mkdirSync(cacheDir, { recursive: true });

  const todo = refs.filter((r) => !cached(cacheDir, r));
  if (todo.length === 0) return reportFrom(cacheDir, refs, 0);

  const image = opts.image;
  const object = opts.object;
  if (image === undefined || object === undefined) throw new Error("assets: live mode needs providers");
  if (opts.maxDollars === undefined) throw new Error("assets: live mode needs --max-dollars");
  if (!Number.isFinite(opts.maxDollars) || opts.maxDollars <= 0) {
    throw new Error(`assets: live mode needs a positive --max-dollars, got ${opts.maxDollars}`);
  }

  const need = todo.reduce((s, r) => s + remainingCents(cacheDir, r), 0);
  const capCents = dollarsToCents(opts.maxDollars);
  if (need > capCents) throw new CapError(need, capCents);
  const budget = new Budget(capCents);

  const log = (ref: AssetRef, cents: number): void =>
    appendLedger(cacheDir, { t: new Date().toISOString(), kind: ref.kind, key: ref.key, cents });

  // An asset whose failure is not retryable (a permanent HTTP error, say
  // 401/403) is skipped on the second pass instead of wasting another attempt.
  const noRetry = new Set<string>();
  const failed: Issue[] = [];
  const ignored = new Set<string>();

  /** The reference image: the asset itself for a tile or decal, the input for an object. */
  const genImage = async (ref: AssetRef): Promise<void> => {
    const p = cachePaths(cacheDir, ref.key);
    // An object may already have its reference image from a prior run whose
    // mesh step failed — only the mesh is still owed, not another image.
    if (ref.kind === "object" && existsSync(p.src)) return;
    if (!budget.take(IMAGE_CENTS)) return;
    // The provider call and the local write are charged exactly once between
    // them: a write failure after a successful call must not log a second
    // row for the same paid attempt.
    let png: Buffer;
    try {
      if (ref.ref !== undefined && image.fromRef !== undefined) {
        png = await image.fromRef(ref.ref, promptFor(ref.kind, ref.prompt), sizeFor(ref.aspect));
      } else {
        // never silently: the build says this object was drawn from text only
        if (ref.ref !== undefined) ignored.add(ref.id);
        png = await image.generate(promptFor(ref.kind, ref.prompt), sizeFor(ref.aspect));
      }
    } catch (e) {
      log(ref, IMAGE_CENTS);
      if (!(e instanceof RetryableError)) noRetry.add(ref.id);
      return;
    }
    log(ref, IMAGE_CENTS);
    if (ref.kind === "sky") {
      // a sky that is not 2:1 is never cached: the page falls back to the
      // gradient stand-in, and a retry would pay for the same wrong canvas
      let fixed = seamSky(png, ref.id);
      // the recipe proper: an edit call paints the band; without one (or if it
      // fails) the model-free cross-fade above stands
      if (fixed.ok && image.edit !== undefined && budget.take(IMAGE_CENTS)) {
        const edit = image.edit.bind(image);
        try {
          fixed = await inpaintSky(png, edit, ref.id);
        } catch {
          // keep the cross-fade: a bad edit must not lose a paid sky
        }
        log(ref, IMAGE_CENTS);
      }
      if (!fixed.ok) {
        failed.push(fixed.issue);
        noRetry.add(ref.id);
        return;
      }
      png = fixed.png;
    }
    try {
      writeCached(ref.kind === "object" ? p.src : p.png, png);
    } catch {
      // A local write failure is permanent for this run: retrying would pay
      // for the same image again without fixing the disk.
      noRetry.add(ref.id);
    }
  };

  const genMesh = async (ref: AssetRef): Promise<void> => {
    const p = cachePaths(cacheDir, ref.key);
    if (!existsSync(p.src)) return;
    if (!budget.take(MESH_CENTS)) return;
    let glb: Buffer;
    try {
      glb = await object.mesh(readFileSync(p.src), ref.id);
    } catch {
      // Any ObjectProvider failure is retried — unlike Muse, it has no
      // permanent-vs-transient distinction here.
      log(ref, MESH_CENTS);
      return;
    }
    log(ref, MESH_CENTS);
    try {
      writeCached(p.glb, glb);
    } catch {
      // Local write failure is permanent for this run: retrying would pay
      // for the same mesh again without fixing the disk.
      noRetry.add(ref.id);
    }
  };

  // Images run in a capped pool; each object's mesh is kicked off the moment
  // its own image resolves, uncapped, so it overlaps unrelated image calls
  // instead of waiting for the whole pool to drain.
  const firstPassMeshes: Promise<void>[] = [];
  await pool(todo, IMAGE_CONCURRENCY, async (ref) => {
    await genImage(ref);
    if (ref.kind === "object") firstPassMeshes.push(genMesh(ref));
  });
  await Promise.all(firstPassMeshes);

  // One retry each, in batch order: a provider hiccup is common, and the
  // second pass is what the cap usually eats into.
  const retryMeshes: Promise<void>[] = [];
  for (const ref of todo) {
    if (cached(cacheDir, ref)) continue;
    if (ref.kind !== "object") {
      if (!noRetry.has(ref.id)) await genImage(ref);
      continue;
    }
    if (!noRetry.has(ref.id)) await genImage(ref);
    if (!noRetry.has(ref.id)) retryMeshes.push(genMesh(ref));
  }
  await Promise.all(retryMeshes);

  const report: AssetReport = reportFrom(cacheDir, refs, budget.spent);
  if (ignored.size > 0) {
    report.warnings = refs.filter((r) => ignored.has(r.id)).map((r) => ({ code: "REF_IGNORED" as const, id: r.id }));
  }
  return failed.length > 0 ? { ...report, failed } : report;
}

function reportFrom(cacheDir: string, refs: AssetRef[], cents: number): AssetReport {
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
  return { used, fallback: missing.slice(), missing, cents };
}
