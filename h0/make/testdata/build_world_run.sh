#!/bin/sh
# Rebuilds the fake world_run fixture offline (no network, no keys).
# scene.json/events.jsonl come from python; dist/ is a real engine build
# (`dreamer build --assets cache`) of the make example scene over a cache of
# fakeGlb/fakePng, so the page loads the engine runtime and renders the scene.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/world_run" && pwd)"

python3 - "$ROOT" <<'EOF'
import base64
import json
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(sys.argv[1])
DIST = ROOT / "dist"

H = 2.7  # wall height, m
LIVING = (0.0, 0.0, 6.0, 5.0)      # x0, z0, x1, z1
KITCHEN = (6.0, 0.5, 10.5, 4.5)
DOOR = {"id": "door1", "from": "living", "to": "kitchen",
        "width_m": 0.9, "hinge": [6.0, 2.05], "opening": [2.05, 2.95]}
PROPS = [
    {"id": "sofa",      "cat": "sofa",      "room": "living",  "size_m": [2.0, 0.9, 0.9],  "pos": [2.0, 4.0],  "rel": "against north wall",   "size": {"w": 2.0, "h": 0.9, "d": 0.9},   "at": [2.0, 4.0],  "solid": True},
    {"id": "armchair",  "cat": "chair",     "room": "living",  "size_m": [0.9, 0.9, 0.9],  "pos": [4.2, 4.0],  "rel": "near sofa",             "size": {"w": 0.9, "h": 0.9, "d": 0.9},   "at": [4.2, 4.0],  "solid": True},
    {"id": "fireplace", "cat": "fireplace", "room": "living",  "size_m": [1.2, 1.3, 0.5],  "pos": [3.0, 0.35], "rel": "against south wall",   "size": {"w": 1.2, "h": 1.3, "d": 0.5},   "at": [3.0, 0.35], "solid": True},
    {"id": "table",     "cat": "table",     "room": "kitchen", "size_m": [1.4, 0.75, 0.9], "pos": [8.0, 2.5],  "rel": "middle of kitchen",    "size": {"w": 1.4, "h": 0.75, "d": 0.9},  "at": [8.0, 2.5],  "solid": True},
    {"id": "cupboard",  "cat": "cupboard",  "room": "kitchen", "size_m": [1.0, 2.0, 0.5],  "pos": [10.1, 1.0], "rel": "against east wall",    "size": {"w": 1.0, "h": 2.0, "d": 0.5},   "at": [10.1, 1.0], "solid": True},
    {"id": "stove",     "cat": "stove",     "room": "kitchen", "size_m": [0.8, 0.9, 0.7],  "pos": [6.6, 4.0],  "rel": "against north wall",   "size": {"w": 0.8, "h": 0.9, "d": 0.7},   "at": [6.6, 4.0],  "solid": True},
    {"id": "lamp",      "cat": "lamp",      "room": "kitchen", "size_m": [0.25, 0.45, 0.25], "pos": [8.0, 2.5], "rel": "on table",            "size": {"w": 0.25, "h": 0.45, "d": 0.25}, "mount": {"top_of": "table"}, "solid": True},
    {"id": "rug",       "cat": "rug",       "room": "living",  "size_m": [2.0, 0.02, 1.4], "pos": [2.5, 2.0],  "rel": "on floor",             "size": {"w": 2.0, "h": 0.02, "d": 1.4},  "at": [2.5, 2.0],  "solid": False},
]

# --- scene.json (rooms + door leaf + sized props) ---
(ROOT / "scene.json").write_text(json.dumps({
    "rooms": [{"id": "living", "size_m": [6, 5], "height": H}, {"id": "kitchen", "size_m": [4.5, 4], "height": H}],
    "doors": [{**DOOR, "leaf": {"width_m": 0.9, "height_m": 2.0,
                                "hinge": "left", "swing": "living"}}],
    "props": PROPS,
}, indent=2) + "\n")

# --- events.jsonl (pipe2 run log shape, fake) ---
(ROOT / "events.jsonl").write_text(
    '{"type":"start"}\n{"type":"asset","name":"sofa"}\n{"type":"done"}\n')
print("fixture rebuilt at " + str(ROOT))
EOF

ENGINE="$(cd "$(dirname "$0")/../../../engine" && pwd)"
SCENE="$ENGINE/../specs/examples/demo-flat.scene.json"
CACHE="$(mktemp -d)"
trap 'rm -rf "$CACHE"' EXIT
cd "$ENGINE"
# fake cache: fakeGlb for objects, fakePng for tiles/decals/sky
node --import tsx -e '
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "./src/check.ts";
import { sceneAssets } from "./src/assets/run.ts";
import { fakeGlb, fakePng } from "./src/assets/providers/fake.ts";
const [scene, cache] = process.argv.slice(1);
const ctx = runCheck(JSON.parse(readFileSync(scene, "utf-8"))).ctx;
for (const a of sceneAssets(ctx.scene)) {
  if (a.kind === "object") writeFileSync(join(cache, a.key + ".glb"), fakeGlb());
  else writeFileSync(join(cache, a.key + ".png"), fakePng(4, 4, [150, 120, 90], a.kind === "decal"));
}
' "$SCENE" "$CACHE"
rm -rf "$ROOT/dist"
node --import tsx bin/dreamer.ts build "$SCENE" --out "$ROOT/dist" --assets cache --cache "$CACHE"
