# gate wiring: runs under tools/ptest.py (unittest) as make.test_bughunt_bNN with cwd h0
import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch
from make import stage as st


def _write_world(tmp: Path):
    wr = tmp / "world_run"
    (wr / "dist").mkdir(parents=True)
    (wr / "scene.json").write_text(json.dumps({
        "props": [],
        "rooms": [{"id": "living", "level": 0}, {"id": "bedroom", "level": 0}, {"id": "kitchen", "level": 0}],
    }))
    (wr / "dist" / "geometry.json").write_text(json.dumps({"meshes": []}))
    (wr / "dist" / "nav.json").write_text(json.dumps({}))
    (wr / "dist" / "build.json").write_text(json.dumps({
        "doors": [
            {"id": "door1", "hinge_at": [0, 0], "closed_end": [1, 0], "open_end": [0, 1],
             "width": 1.0, "rooms": ["living", "bedroom"], "swing": "living"},
            {"id": "door2", "hinge_at": [5, 5], "closed_end": [6, 5], "open_end": [5, 6],
             "width": 1.0, "rooms": ["living", "kitchen"], "swing": "living"},
        ]
    }))
    return wr


class _FakeNav:
    def __init__(self, *a, **k):
        pass

    def snap(self, level, x, z):
        return [x, z]


def test_two_doors_in_one_room_have_unique_names(tmp_path):
    wr = _write_world(tmp_path)
    with patch.object(st, "_Nav", _FakeNav):
        res = st.build_places(str(wr))
    doors = [p for p in res["places"] if p.get("kind") == "door"]
    assert len(doors) == 2, f"expected 2 door places, got {res}"
    names = [p["name"] for p in doors]
    assert len(set(names)) == len(names), f"duplicate door place names: {names}"


class BughuntB13(unittest.TestCase):
    def test_b13(self):
        with tempfile.TemporaryDirectory() as d:
            test_two_doors_in_one_room_have_unique_names(Path(d))
