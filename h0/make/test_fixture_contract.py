"""M4 red: real fixture world_run/ matches its scene.json + cast/ + nav snap edges (F1-F5)."""
import base64
import json
import unittest
from pathlib import Path

from . import stage

DATA = Path(__file__).resolve().parent / "testdata"
WORLD_RUN = DATA / "world_run"


def _bits(w, h, walkable):
    n = bytearray((w * h + 7) // 8)
    for (i, j) in walkable:
        k = j * w + i
        n[k >> 3] |= 1 << (k & 7)
    return base64.b64encode(bytes(n)).decode()


class FixtureContract(unittest.TestCase):
    def test_world_run_matches_scene(self):  # F1
        res = stage.build_places(str(WORLD_RUN))
        ids = {p["id"] for p in res["places"]}
        for want in ("living_sofa", "living_armchair", "kitchen_table"):
            self.assertIn(want, ids, (sorted(ids), res["warnings"]))
        names = {p["name"] for p in res["places"]}
        for want in ("sofa", "armchair", "table"):
            self.assertIn(want, names, (sorted(names), res["warnings"]))
        self.assertTrue(any(p["kind"] == "door" for p in res["places"]))
        names = {p["name"] for p in res["places"]}
        self.assertNotIn("lamp", names)
        self.assertNotIn("rug", names)
        self.assertFalse([w for w in res["warnings"] if "no prop in scene.json" in w],
                         res["warnings"])

    def test_cast_present(self):  # F2
        self.assertTrue((DATA / "cast" / "cast.json").is_file())
        glbs = list((DATA / "cast").glob("*.glb"))
        self.assertEqual(len(glbs), 2, [p.name for p in glbs])

    def test_snap_missing_level_is_none(self):  # F3
        nav = stage._Nav({"cell": 1.0, "layers": [
            {"level": "L0", "origin": [0, 0], "w": 2, "h": 2,
             "bits": _bits(2, 2, [(0, 0), (1, 0), (0, 1), (1, 1)])}]})
        self.assertIsNone(nav.snap("L1", 0.5, 0.5))

    def test_snap_outside_grid_not_returned(self):  # F4
        nav = stage._Nav({"cell": 1.0, "layers": [
            {"level": "L0", "origin": [0, 0], "w": 1, "h": 1, "bits": _bits(1, 1, [(0, 0)])}]})
        self.assertNotEqual(nav.snap("L0", -0.2, 0.5), [-0.2, 0.5])

    def test_snap_radius_to_center(self):  # F5
        nav = stage._Nav({"cell": 0.04, "layers": [
            {"level": "L0", "origin": [0, 0], "w": 30, "h": 1,
             "bits": _bits(30, 1, [(25, 0)])}]})
        self.assertIsNone(nav.snap("L0", 0.0004, 0.02))


if __name__ == "__main__":
    unittest.main()
