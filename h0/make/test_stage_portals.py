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


if __name__ == "__main__":
    unittest.main()
