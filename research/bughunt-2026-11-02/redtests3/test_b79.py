from pathlib import Path

from pipe2.floor import attach_refs


def _scene(nested=True):
    props = [
        {"id": "bedroom_shelf", "asset": "shelf", "room": "bedroom"},
        {"id": "bedroom_box", "asset": "box", "room": "bedroom",
         "mount": {"top_of": "bedroom_shelf"}},
    ]
    assets = {
        "shelf": {"kind": "object"},
        "box": {"kind": "object"},
        "toy": {"kind": "object"},
    }
    if nested:
        props.append({"id": "bedroom_toy", "asset": "toy", "room": "bedroom",
                      "mount": {"top_of": "bedroom_box"}})
    return {"assets": assets, "props": props}


def _attach(scene, tmp_path):
    frame = tmp_path / "bedroom.png"
    frame.write_bytes(b"frame")
    attach_refs(scene, {"rooms": {"bedroom": {"refs": [str(frame)]}}}, tmp_path / "run")


def _assert_no_dangling_mounts(scene):
    ids = {p["id"] for p in scene["props"]}
    dangling = [p["mount"].get("top_of") or p["mount"].get("tier_of")
                for p in scene["props"] if isinstance(p.get("mount"), dict)
                and (p["mount"].get("top_of") or p["mount"].get("tier_of")) not in ids]
    assert not dangling, f"expected all mount hosts to remain, got dangling references {dangling}"


def test_nested_mounts_do_not_reference_removed_box(tmp_path):
    scene = _scene()
    _attach(scene, tmp_path)
    _assert_no_dangling_mounts(scene)


def test_single_mount_level_is_removed_without_dangling_reference(tmp_path):
    scene = _scene(nested=False)
    _attach(scene, tmp_path)
    _assert_no_dangling_mounts(scene)
    assert [p["id"] for p in scene["props"]] == ["bedroom_shelf"]
