"""Red: fake world fixture must be usable for later stages (F2/F6/F8)."""
import json
import unittest
from pathlib import Path

DATA = Path(__file__).resolve().parent / "testdata" / "world_run"


class FakeFixtureUsable(unittest.TestCase):
    def test_geometry_has_meshes_and_floors(self):
        g = json.loads((DATA / "dist" / "geometry.json").read_text())
        self.assertTrue(g.get("meshes"), "geometry.json needs meshes")
        self.assertTrue(g.get("floors"), "geometry.json needs floors")

    def test_scene_rooms_props_door(self):
        sc = json.loads((DATA / "scene.json").read_text())
        self.assertGreaterEqual(len(sc.get("rooms", [])), 2)
        self.assertGreaterEqual(len(sc.get("props", [])), 5)
        for p in sc["props"]:
            self.assertIn("size_m", p, f"prop {p.get('id')} needs size_m")
        for d in sc.get("doors", []):
            self.assertIn("leaf", d, "door needs leaf data")

    def test_build_script_exists(self):
        self.assertTrue((DATA.parent / "build_world_run.sh").is_file())


if __name__ == "__main__":
    unittest.main()
