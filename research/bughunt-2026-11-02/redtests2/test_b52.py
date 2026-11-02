# B52: a door must not take the name of a prop place "<room> door"
import json
from pathlib import Path

from make import stage
from make.testdata import synth_world


def test_door_name_unique_against_prop_named_room_door(tmp_path):
    wr = synth_world.write(tmp_path / "w", glb=False)
    scene = json.loads((wr / "scene.json").read_text())
    geo = json.loads((wr / "dist" / "geometry.json").read_text())
    size = {"w": 0.8, "h": 2.0, "d": 0.2}
    for room, cx in (("living", 3.0), ("kitchen", 9.0)):   # two `door` props -> named "<room> door"
        pid = f"{room}_door"
        scene["props"].append({"id": pid, "room": room, "yaw": 0.0, "size": size, "at": [cx, 1.0]})
        geo["meshes"].append({"id": pid, "kind": "prop", "room": room,
                              "positions": synth_world._box(cx, 1.0, size["w"], size["d"], size["h"])})
    (wr / "scene.json").write_text(json.dumps(scene))
    (wr / "dist" / "geometry.json").write_text(json.dumps(geo))

    places = stage.build_places(wr)["places"]
    names = [p["name"] for p in places]
    dup = sorted({n for n in names if names.count(n) > 1})
    assert not dup, f"expected unique place names, got duplicates {dup} in {names}"
