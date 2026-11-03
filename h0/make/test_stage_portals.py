"""Squidward v8, Nov 3 ("они же ушли на улицу"): a door can lead to another place, San Andreas style (engine
stage `Place.to`). scene.json says it: an opening's `to` names where one comes out, a door id or a portal id;
`portals` are door spots on an open place (the street has no walls to cut a door in: the tiki head's front door
is a spot in front of its mesh). Each becomes a door place; `to` turns into that place's name."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import stage
from .testdata import synth_world


def _world(edit):
    d = Path(tempfile.mkdtemp())
    synth_world.write(d, glb=False)
    s = json.loads((d / "scene.json").read_text())
    edit(s)
    (d / "scene.json").write_text(json.dumps(s))
    return stage.build_places(d)


class Portals(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def _both(self):
        def edit(s):
            s["openings"] = [{"id": "door1", "to": "tiki_front"}]
            s["portals"] = [{"id": "tiki_front", "room": "kitchen", "at": [6.0, 1.0], "yaw": 180, "name": "tiki door", "to": "door1"}]
        return {p["name"]: p for p in _world(edit)["places"]}

    def test_door_to_a_portal(self):
        d = self._both()["living door"]
        self.assertEqual(d["to"], "tiki door")

    def test_portal_is_a_door_place_back(self):
        p = self._both()["tiki door"]
        self.assertEqual(p["kind"], "door")
        self.assertEqual(p["id"], "tiki_front")
        self.assertEqual(p["room"], "kitchen")
        self.assertEqual(p["at"], [6.0, 1.0])
        self.assertEqual(p["yaw"], 180)
        self.assertEqual(p["poses"], ["door"])
        self.assertEqual(p["to"], "living door")

    def test_unknown_to_warns_and_is_dropped(self):
        def edit(s):
            s["openings"] = [{"id": "door1", "to": "nowhere"}]
        res = _world(edit)
        d = {p["name"]: p for p in res["places"]}["living door"]
        self.assertNotIn("to", d)
        self.assertTrue(any("nowhere" in w for w in res["warnings"]))

    def test_no_to_no_change(self):
        d = {p["name"]: p for p in _world(lambda s: None)["places"]}["living door"]
        self.assertNotIn("to", d)


class LeaflessDoor(unittest.TestCase):
    """the pineapple's front door is a hole, no leaf: build.json has no door for it, yet with `to` it is a door place
    (inside its room, a step in from the opening, facing in), and the portal outside leads to it"""
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def _res(self):
        d = Path(tempfile.mkdtemp())
        synth_world.write(d, glb=False)
        s = json.loads((d / "scene.json").read_text())
        s["openings"] = [{"id": "hole", "kind": "door", "at": [3.0, 0.0], "width": 1.0, "to": "out"}]
        s["portals"] = [{"id": "out", "room": "kitchen", "at": [8.0, 2.0], "yaw": 0, "name": "street spot", "to": "hole"}]
        (d / "scene.json").write_text(json.dumps(s))
        g = json.loads((d / "dist" / "geometry.json").read_text())
        g["floors"] = [{"room": "living", "level": "L0", "y": 0, "outline": [[0, 0], [6, 0], [6, 5], [0, 5]]},
                       {"room": "kitchen", "level": "L0", "y": 0, "outline": [[6, 0], [10, 0], [10, 5], [6, 5]]}]
        (d / "dist" / "geometry.json").write_text(json.dumps(g))
        return stage.build_places(d)

    def test_hole_with_to_is_a_door_place(self):
        res = self._res()
        p = {q["name"]: q for q in res["places"]}
        hole = next(q for q in res["places"] if q["id"] == "hole")
        self.assertEqual(hole["kind"], "door")
        self.assertEqual(hole["room"], "living")
        self.assertEqual(hole["to"], "street spot")
        self.assertGreater(hole["at"][1], 0.2)  # a step in from the wall at z = 0
        self.assertLess(abs(hole["at"][0] - 3.0), 0.5)
        self.assertLess(abs((hole["yaw"] - 0 + 180) % 360 - 180), 20)  # into the room: +z
        self.assertEqual(p["street spot"]["to"], hole["name"])


if __name__ == "__main__":
    unittest.main()
