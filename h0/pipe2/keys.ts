// prints what the engine's cache needs for a scene: one line per referenced asset
// (no triangle budget: the cache keeps the full mesh, `build` cuts it per scene)
import { readFileSync } from "node:fs";
import { sceneAssets } from "../../engine/src/assets/run.ts";
import { promptFor, sizeFor } from "../../engine/src/assets/templates.ts";
const scene = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const out = sceneAssets(scene).map((r) => ({ id: r.id, kind: r.kind, key: r.key, prompt: promptFor(r.kind, r.prompt),
  size: r.kind === "object" ? "1024x1024" : sizeFor(r.aspect ?? "1:1") }));
console.log(JSON.stringify(out));
