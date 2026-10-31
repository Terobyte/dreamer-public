"""Hand-sized world_run for the `stage` adapter tests: numbers are chosen so every
expectation in `expect_touch.json` and the door example can be checked by hand.

Two rooms (living 6x5, kitchen 4.5x4 at x 6..10.5), one door with a leaf, GLB and
placeholder props, nav grid 0.04 m walkable only inside x 0..10.5, z 0..5.
`write(dir, glb=True)` -> dir/{scene.json, dist/{geometry,nav,build}.json}.
"""
import base64
import json
import math
from pathlib import Path

CELL = 0.04
ORIGIN = (-1.0, -1.0)
W, H = 300, 250  # cells: x -1..11, z -1..9


def _box(cx, cz, w, d, h):
    x0, x1, z0, z1 = cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2
    return [x0, 0, z0, x1, 0, z0, x1, h, z1, x0, h, z1]


PROPS = [
    # id, room, scene fields, centre (x, z), yaw degrees
    ("living_sofa", "living", {"size": {"w": 2.0, "h": 0.9, "d": 0.9}, "at": [2.0, 4.0]}, (2.0, 4.0), 90.0),
    ("living_armchair", "living", {"size": {"w": 0.9, "h": 0.9, "d": 0.9}, "at": [4.2, 4.0]}, (4.2, 4.0), 180.0),
    ("living_window", "living", {"size": {"w": 1.0, "h": 1.2, "d": 0.2}, "at": [1.0, 0.3]}, (1.0, 0.3), 0.0),
    ("living_rug", "living", {"size": {"w": 2.0, "h": 0.02, "d": 1.4}, "at": [2.5, 2.0], "solid": False}, (2.5, 2.0), 0.0),
    ("kitchen_table", "kitchen", {"size": {"w": 1.4, "h": 0.75, "d": 0.9}, "at": [8.0, 2.5]}, (8.0, 2.5), 0.0),
    ("kitchen_lamp", "kitchen", {"size": {"w": 0.25, "h": 0.45, "d": 0.25}, "mount": {"top_of": "kitchen_table"}}, (8.0, 2.5), 0.0),
    ("kitchen_stool", "kitchen", {"size": {"w": 0.4, "h": 0.45, "d": 0.4}, "at": [7.2, 2.5]}, None, 0.0),
    ("kitchen_cabinet", "kitchen", {"size": {"w": 1.0, "h": 2.0, "d": 0.5}, "at": [12.0, 2.0]}, (12.0, 2.0), 0.0),
]
COPIES = [("kitchen_stool.0", (7.2, 3.4), 0.0), ("kitchen_stool.1", (7.2, 1.6), 180.0)]


def _nav_bits():
    n = bytearray((W * H + 7) // 8)
    for j in range(H):
        z = ORIGIN[1] + (j + 0.5) * CELL
        for i in range(W):
            x = ORIGIN[0] + (i + 0.5) * CELL
            if 0.0 <= x <= 10.5 and 0.0 <= z <= 5.0:
                k = j * W + i
                n[k >> 3] |= 1 << (k & 7)
    return base64.b64encode(bytes(n)).decode()


def write(root, glb=True):
    root = Path(root)
    (root / "dist").mkdir(parents=True, exist_ok=True)
    scene_props, meshes = [], []

    def mesh(mid, room, c, yaw, size):
        m = {"id": mid, "kind": "prop", "room": room}
        if glb:
            m.update(glb="assets/p_x.glb", glbPos=[c[0], 0, c[1]], glbYaw=math.radians(yaw))
        else:  # placeholder: AABB centre is the place, yaw lives in scene.json
            m["positions"] = _box(c[0], c[1], size["w"], size["d"], size["h"])
        meshes.append(m)

    for pid, room, sc, c, yaw in PROPS:
        scene_props.append({"id": pid, "room": room, "yaw": yaw, **sc})
        if c is not None:
            mesh(pid, room, c, yaw, sc["size"])
    for mid, c, yaw in COPIES:
        mesh(mid, "kitchen", c, yaw, PROPS[6][2]["size"])
    scene = {"rooms": [{"id": "living", "level": "L0", "height": 2.7}, {"id": "kitchen", "level": "L0", "height": 2.7}],
             "props": scene_props}
    (root / "scene.json").write_text(json.dumps(scene, indent=1))
    (root / "dist" / "geometry.json").write_text(json.dumps({"version": 1, "meshes": meshes, "floors": []}))
    (root / "dist" / "nav.json").write_text(json.dumps(
        {"cell": CELL, "layers": [{"level": "L0", "y": 0, "origin": list(ORIGIN), "w": W, "h": H, "bits": _nav_bits()}],
         "doors": [], "ramps": [], "links": []}))
    (root / "dist" / "build.json").write_text(json.dumps({"doors": [
        {"id": "door1", "rooms": ["living", "kitchen"], "hinge_at": [6.0, 2.05], "swing": "living",
         "width": 0.9, "closed_end": [6.0, 2.95], "open_end": [5.1, 2.05]}]}))
    return root
