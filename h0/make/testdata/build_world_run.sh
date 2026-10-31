#!/bin/sh
# Rebuilds the make fixtures offline (no network, no keys).
# world_run/scene.json + events.jsonl and the engine scene come from one python
# source (rooms/props/door defined once, so dist/ can never drift from scene.json);
# dist/ is a real engine build (`dreamer build --assets cache`) over a cache of
# fakeGlb/fakePng. cast/ holds cast.json + 2 GLBs from fakeGlb.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/world_run" && pwd)"
TESTDATA="$(dirname "$ROOT")"
SCENE_TMP="$(mktemp -t make-flat.scene.XXXXXX.json)"
trap 'rm -rf "$CACHE" "$SCENE_TMP"' EXIT

python3 - "$ROOT" "$TESTDATA" "$SCENE_TMP" <<'EOF'
import json
import sys
from pathlib import Path

ROOT, TESTDATA, SCENE_TMP = (Path(a) for a in sys.argv[1:])

H = 2.7
ROOMS = [
    {"id": "living", "level": "L0", "size_m": [6, 5], "height": H,
     "shape": [[0, 5], [0, 0], [6, 0], [6, 5]]},
    {"id": "kitchen", "level": "L0", "size_m": [4.5, 5], "height": H,
     "shape": [[6, 5], [6, 0], [10.5, 0], [10.5, 5]]},
]
DOOR = {"id": "door1", "from": "living", "to": "kitchen", "width_m": 0.9,
        "hinge": [6.0, 2.05], "opening": [2.05, 2.95],
        "leaf": {"width_m": 0.9, "height_m": 2.0, "hinge": "left", "swing": "living"}}
# id/room/size/yaw/at/solid/mount are shared by the engine scene and scene.json;
# asset/cat exist only for the engine build.
PROPS = [
    {"id": "living_sofa", "asset": "p_sofa", "cat": "sofa", "room": "living",
     "at": [2.0, 3.9], "size": {"w": 2.0, "h": 0.9, "d": 0.9}, "yaw": 90.0, "solid": True},
    {"id": "living_armchair", "asset": "p_armchair", "cat": "armchair", "room": "living",
     "at": [4.2, 4.0], "size": {"w": 0.9, "h": 0.9, "d": 0.9}, "yaw": 180.0, "solid": True},
    {"id": "living_rug", "asset": "p_rug", "cat": "rug", "room": "living",
     "at": [2.5, 2.0], "size": {"w": 2.0, "h": 0.02, "d": 1.4}, "yaw": 0.0, "solid": False},
    {"id": "kitchen_table", "asset": "p_table", "cat": "table", "room": "kitchen",
     "at": [8.0, 2.5], "size": {"w": 1.4, "h": 0.75, "d": 0.9}, "yaw": 0.0, "solid": True},
    {"id": "kitchen_lamp", "asset": "p_lamp", "cat": "lamp", "room": "kitchen",
     "size": {"w": 0.25, "h": 0.45, "d": 0.25}, "yaw": 0.0,
     "mount": {"top_of": "kitchen_table"}, "solid": False},
    {"id": "kitchen_stool", "asset": "p_stool", "cat": "chair", "room": "kitchen",
     "size": {"w": 0.4, "h": 0.5, "d": 0.4},
     "around": {"center": "kitchen_table", "n": 2, "r": 0.9, "start": 0}, "solid": True},
]

# --- world_run/scene.json (rooms + door leaf + sized props) ---
# cat/size_m stay in scene.json for the engine-contract gate tests; the lamp's
# mount points at the short "table" id there, the engine scene below keeps the
# real "kitchen_table" id for the actual mount.
scene_props = []
for p in PROPS:
    s = {k: p[k] for k in ("id", "room", "cat", "size", "yaw", "at", "solid", "mount") if k in p}
    s["size_m"] = [p["size"]["w"], p["size"]["h"], p["size"]["d"]]
    if s.get("mount", {}).get("top_of") == "kitchen_table":
        s["mount"] = {"top_of": "table"}
    scene_props.append(s)
(ROOT / "scene.json").write_text(json.dumps({
    "rooms": [{k: r[k] for k in ("id", "level", "size_m", "height")} for r in ROOMS],
    "doors": [DOOR],
    "props": scene_props,
}, indent=2) + "\n")

# --- the engine scene actually built into dist/ (same rooms/props/door) ---
engine_props = []
for p in PROPS:
    e = {"id": p["id"], "asset": p["asset"], "cat": p["cat"], "room": p["room"],
         "size": {"w": p["size"]["w"], "d": p["size"]["d"], "h": p["size"]["h"]},
         "mount": p.get("mount", "floor"), "solid": p.get("solid", True)}
    if "at" in p:
        e["at"] = p["at"]
    if "yaw" in p and "around" not in p:
        e["yaw"] = p["yaw"]
    if "around" in p:
        e["around"] = p["around"]
    engine_props.append(e)
SCENE_TMP.write_text(json.dumps({
    "version": 0, "name": "make-flat",
    "spawn": {"room": "living", "at": [1, 1], "yaw": 180},
    "style": {"ambient": 1.0, "exterior": "#8a8a80"},
    "materials": {
        "olive": {"tile": "t_wall", "repeat_m": 2.0},
        "parquet": {"tile": "t_floor", "repeat_m": 1.2},
        "plaster": {"color": "#c8c27a"},
        "wood": {"color": "#7a5230"},
        "white": {"color": "#eeeae0"},
    },
    "levels": [{"id": "L0", "y": 0}],
    "rooms": [
        {"id": r["id"], "level": r["level"], "height": r["height"], "shape": r["shape"],
         "floor": "parquet", "ceiling": "plaster" if r["id"] == "living" else "white",
         "walls": {"material": "olive" if r["id"] == "living" else "white",
                    "bands": [{"to": 0.12, "material": "wood"}]}}
        for r in ROOMS
    ],
    "openings": [
        {"id": DOOR["id"], "kind": "door", "at": [6, 2.5], "width": DOOR["width_m"],
         "height": 2.1, "sill": 0, "leaf": {"decal": "d_door", "open": True}},
    ],
    "props": engine_props,
    "lights": [
        {"kind": "hemi", "pos": [3, 3, 2.5], "color": "#fff4e0", "power": 0.8},
        {"kind": "point", "pos": [2, 2.4, 4], "color": "#ffd8b0", "power": 0.7},
        {"kind": "point", "pos": [8, 2.4, 2.5], "color": "#fff4e0", "power": 0.7},
    ],
    "assets": {
        "t_wall": {"kind": "tile", "prompt": "dark olive green mottled painted stone"},
        "t_floor": {"kind": "tile", "prompt": "pink-mauve wooden parquet, basket weave"},
        "d_door": {"kind": "decal", "prompt": "a tall narrow door of vertical yellow bamboo poles",
                   "aspect": "1:2"},
        "p_sofa": {"kind": "object", "prompt": "a long sofa with a yellow bamboo frame"},
        "p_armchair": {"kind": "object", "prompt": "an armchair with a yellow bamboo frame"},
        "p_rug": {"kind": "object", "prompt": "a flat woven rug"},
        "p_table": {"kind": "object", "prompt": "a square wooden kitchen table"},
        "p_lamp": {"kind": "object", "prompt": "a small table lamp with a pale shade"},
        "p_stool": {"kind": "object", "prompt": "a plain wooden kitchen stool"},
    },
    "cameras": [
        {"id": "door", "pos": [1, 1.6, 1], "look": [4, 1.2, 3], "fov": 70},
    ],
    "routes": [
        {"id": "in", "path": ["spawn", "door1", {"room": "kitchen", "at": [8, 3.5]}]},
    ],
}, indent=1) + "\n")

# --- events.jsonl (pipe2 run log shape, fake) ---
(ROOT / "events.jsonl").write_text(
    '{"type":"start"}\n{"type":"asset","name":"sofa"}\n{"type":"done"}\n')

# --- cast/ (path A: files placed by hand; voices are labels from voices.json) ---
cast = TESTDATA / "cast"
cast.mkdir(exist_ok=True)
(cast / "cast.json").write_text(json.dumps({
    "Jane Eyre": {"glb": "jane.glb", "voice": "woman", "sex": "female",
                  "look": "a young woman in a plain grey dress", "height_m": 1.7},
    "Edward Rochester": {"glb": "rochester.glb", "voice": "man", "sex": "male",
                         "look": "a brooding man in a dark coat", "height_m": 1.8},
}, indent=2) + "\n")
print("fixture sources written at " + str(ROOT) + " and " + str(cast))
EOF

ENGINE="$(cd "$(dirname "$0")/../../../engine" && pwd)"
CACHE="$(mktemp -d)"
cd "$ENGINE"
# fake cache: fakeGlb for objects, fakePng for tiles/decals/sky; cast GLBs from fakeGlb
node --import tsx -e '
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "./src/check.ts";
import { sceneAssets } from "./src/assets/run.ts";
import { fakeGlb, fakePng } from "./src/assets/providers/fake.ts";
const [scene, cache, cast] = process.argv.slice(1);
const ctx = runCheck(JSON.parse(readFileSync(scene, "utf-8"))).ctx;
for (const a of sceneAssets(ctx.scene)) {
  if (a.kind === "object") writeFileSync(join(cache, a.key + ".glb"), fakeGlb());
  else writeFileSync(join(cache, a.key + ".png"), fakePng(4, 4, [150, 120, 90], a.kind === "decal"));
}
for (const name of ["jane", "rochester"]) writeFileSync(join(cast, name + ".glb"), fakeGlb());
' "$SCENE_TMP" "$CACHE" "$TESTDATA/cast"
rm -rf "$ROOT/dist"
node --import tsx bin/dreamer.ts build "$SCENE_TMP" --out "$ROOT/dist" --assets cache --cache "$CACHE"
