"""Phase M4 red: `stage` adapter world/run -> places.json (spec «stage — банк мест»)."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import stage
from .testdata import synth_world

DATA = Path(__file__).resolve().parent / "testdata"


def _places(glb=True):
    d = Path(tempfile.mkdtemp())
    synth_world.write(d, glb=glb)
    return stage.build_places(d)


def _by_name(res):
    return {p["name"]: p for p in res["places"]}


class Places(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def test_glb_position_yaw_and_sit(self):
        p = _by_name(_places())
        a = p["armchair"]
        self.assertEqual(a["kind"], "sit")
        self.assertAlmostEqual(a["yaw"], 180.0, delta=0.5)
        self.assertAlmostEqual(a["at"][0], 4.2, delta=0.05)
        self.assertAlmostEqual(a["at"][1], 3.65, delta=0.05)  # d/2 - 0.1 = 0.35 in front
        self.assertEqual(a["room"], "living")
        self.assertEqual(p["sofa"]["kind"], "sit")
        self.assertAlmostEqual(p["sofa"]["at"][0], 2.35, delta=0.05)
        self.assertEqual(p["window"]["kind"], "stand")
        self.assertAlmostEqual(p["window"]["at"][1], 0.85, delta=0.05)  # 0.1 + 0.45

    def test_glb_equals_placeholder(self):
        g, h = _by_name(_places(True)), _by_name(_places(False))
        for name in ("armchair", "sofa", "window", "table"):
            self.assertAlmostEqual(g[name]["yaw"], h[name]["yaw"], delta=1.0, msg=name)
            for i in (0, 1):
                self.assertAlmostEqual(g[name]["at"][i], h[name]["at"][i], delta=0.05, msg=name)

    def test_lamp_and_rug_have_no_place_or_obstacle(self):
        res = _places()
        names = {p["name"] for p in res["places"]}
        self.assertNotIn("lamp", names)
        self.assertNotIn("rug", names)
        self.assertEqual(len([p for p in res["places"] if p.get("obstacle")]),
                         len([p for p in res["places"] if p["kind"] != "door"]))
        for p in res["places"]:
            self.assertNotIn("rug", p.get("id", ""))

    def test_obstacle_is_rotated_bbox(self):
        sofa = _by_name(_places())["sofa"]  # 2.0 x 0.9 turned 90 deg -> 0.9 wide in x, 2.0 in z
        x0, z0, x1, z1 = sofa["obstacle"]
        self.assertAlmostEqual(x1 - x0, 0.9, delta=0.01)
        self.assertAlmostEqual(z1 - z0, 2.0, delta=0.01)

    def test_copies_names_repeat_with_room_then_suffix(self):
        names = [p["name"] for p in _places()["places"]]
        self.assertIn("kitchen stool", names)
        self.assertIn("kitchen stool 2", names)
        self.assertNotIn("stool", names)

    def test_door_numeric_example(self):
        d = _by_name(_places())["living door"]
        self.assertEqual(d["kind"], "door")
        self.assertEqual(d["room"], "living")
        self.assertAlmostEqual(d["at"][0], 4.8, delta=0.05)  # c + u * (0.9 + 0.3)
        self.assertAlmostEqual(d["at"][1], 2.5, delta=0.05)
        self.assertEqual(d["look"], [6.0, 2.5])
        self.assertFalse(d.get("obstacle"))

    def test_no_nav_cell_warns_and_drops_place(self):
        res = _places()
        self.assertNotIn("cabinet", _by_name(res))
        self.assertTrue(any("cabinet" in w for w in res["warnings"]), res["warnings"])

    def test_expect_touch_numbers_match_adapter(self):
        exp = json.loads((DATA / "expect_touch.json").read_text())
        a = next(p for p in stage.build_places(str(DATA / "world_run"))["places"]
                 if p["id"] == "living_armchair")
        c1, c2, c3, c4 = exp["cases"]
        self.assertEqual(c1["place"], "armchair")
        self.assertAlmostEqual(c1["target"][0], a["at"][0], delta=0.05)
        self.assertAlmostEqual(c1["target"][1], a["at"][1], delta=0.05)
        self.assertAlmostEqual(c1["yaw"], a["yaw"], delta=2)
        self.assertEqual(c1["act"], "sit")
        self.assertEqual((c2["act"], c2["holder"]), ("idle", "Edward Rochester"))
        # 0.8 m sideways, perpendicular to the chair yaw, towards Jane (who starts west of it)
        self.assertAlmostEqual(c2["target"][0], a["at"][0] - 0.8, delta=0.05)
        self.assertAlmostEqual(c2["target"][1], a["at"][1], delta=0.05)
        self.assertEqual((c3["who"], c3["place"]), ("Edward Rochester", "window"))
        self.assertIn("window", _by_name(_places()))
        self.assertEqual(c4["skip"], "unknown")


class StageJson(unittest.TestCase):
    def test_write_stage_files(self):
        d = Path(tempfile.mkdtemp())
        world = d / "world" / "run"
        synth_world.write(world)
        out = d / "stage"
        out.mkdir()
        sj = stage.write_stage(d, out, brief={"mode": "seed", "book": None}, freestyle=False)
        self.assertTrue((out / "places.json").is_file())
        for k in ("dist", "places", "cast", "mode", "book", "seed", "objects", "voices", "narrator_voice", "start"):
            self.assertIn(k, sj)
        self.assertEqual(sj["dist"], "world/run/dist")
        pj = json.loads((out / "places.json").read_text())
        self.assertEqual(sorted(sj["objects"]), sorted(p["name"] for p in pj["places"]))


if __name__ == "__main__":
    unittest.main()
