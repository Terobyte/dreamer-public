// prints what the engine's cache needs for a scene: one line per referenced asset
// (no triangle budget: the cache keeps the full mesh, `build` cuts it per scene)
//
// A `ref` on an object is resolved against the scene file's own folder, exactly
// like `withRefs` in `run.ts`: the key folds in the frame bytes and `what`, and
// the row carries the frame (base64) so the queue paints from the picture, not
// from a retelling of it. Unresolvable refs fall back to the text key; the
// build itself reports REF_PATH / REF_MISSING.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sceneAssets } from "../../engine/src/assets/run.ts";
import { cacheKey } from "../../engine/src/assets/cache.ts";
import { promptFor, sizeFor } from "../../engine/src/assets/templates.ts";
const scenePath = process.argv[2];
const scene = JSON.parse(readFileSync(scenePath, "utf-8"));
const root = dirname(resolve(scenePath));
const declared = (scene?.assets ?? {}) as Record<string, any>;
/** Strictly inside `root`: exact at `/`, whole path components only. */
const inside = (base: string, full: string): boolean => {
  const rel = relative(base, full);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const out = sceneAssets(scene).map((r) => {
  const base = { id: r.id, kind: r.kind, key: r.key, prompt: promptFor(r.kind, r.prompt),
    size: r.kind === "object" ? "1024x1024" : sizeFor(r.aspect ?? "1:1") } as Record<string, any>;
  const want = declared[r.id]?.ref;
  if (r.kind !== "object" || want === undefined || want === null) return base;
  const image = String(want.image ?? "");
  const what = String(want.what ?? "");
  if (image === "") return base;
  const full = resolve(root, image);
  // a symlink inside the scene folder pointing outside it must not leak its
  // bytes into the key; anything unresolvable keeps the text key
  let real: string;
  try {
    if (isAbsolute(image) || !inside(root, full)) return base;
    if (!existsSync(full) || !statSync(full).isFile()) return base;
    real = realpathSync(full);
    if (!inside(realpathSync(root), real)) return base;
  } catch {
    return base;
  }
  const bytes = readFileSync(real);
  return { ...base, key: cacheKey(r.kind, r.prompt, r.aspect, { bytes, what }),
    ref: { bytes: bytes.toString("base64"), what } };
});
console.log(JSON.stringify(out));
