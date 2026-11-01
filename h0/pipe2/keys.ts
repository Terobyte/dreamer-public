// prints what the engine's cache needs for a scene: one line per referenced asset
import { readFileSync } from "node:fs";
import { sceneAssets } from "../../engine/src/assets/run.ts";
import { promptFor, sizeFor } from "../../engine/src/assets/templates.ts";
import { TRI_LIMITS, propClass } from "../../engine/src/budget.ts";
const scene = JSON.parse(readFileSync(process.argv[2], "utf-8"));
// an object's mesh is cut to the budget `check` holds it to; one GLB serves every prop that uses it, so the tightest wins
const tris = (id: string): number | undefined => {
  const limits = ((scene.props ?? []) as any[]).filter((p) => p?.asset === id && p?.size).map((p) => TRI_LIMITS[propClass(p.size)]);
  return limits.length ? Math.min(...limits) : undefined;
};
const out = sceneAssets(scene).map((r) => ({ id: r.id, kind: r.kind, key: r.key, prompt: promptFor(r.kind, r.prompt),
  size: r.kind === "object" ? "1024x1024" : sizeFor(r.aspect ?? "1:1"),
  ...(r.kind === "object" && tris(r.id) !== undefined ? { tris: tris(r.id) } : {}) }));
console.log(JSON.stringify(out));
