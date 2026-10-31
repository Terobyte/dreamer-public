"""M4 red: stage contract findings F4/F10 (snap bounds), F6 (mount floor),
F7 (expect_touch anchored to world_run), F8 (size kept), F9 (start map).
usage: cd h0 && python3 -m unittest -q make.test_stage_fix"""
import base64
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import stage
from .testdata import synth_world

DATA = Path(__file__).resolve().parent / "testdata"
WORLD_RUN = DATA / "world_run"
JANE = Path(__file__).resolve().parents[1] / "dream" / "books" / "jane-eyre"


def _bits(w, h, walkable):
    n = bytearray((w * h + 7) // 8)
    for (i, j) in walkable:
        k = j * w + i
        n[k >> 3] |= 1 << (k & 7)
    return base64.b64encode(bytes(n)).decode()


class SnapBounds(unittest.TestCase):
    def test_just_outside_origin_snaps_to_centre(self):  # F10
        nav = stage._Nav({"cell": 1.0, "layers": [
            {"level": "L0", "origin": [0, 0], "w": 1, "h": 1,
             "bits": _bits(1, 1, [(0, 0)])}]})
        self.assertEqual(nav.snap("L0", -5e-10, 0.5), [0.5, 0.5])

    def test_outside_grid_never_echoed(self):  # F4
        nav = stage._Nav({"cell": 1.0, "layers": [
            {"level": "L0", "origin": [0, 0], "w": 3, "h": 3,
             "bits": _bits(3, 3, [(0, 0)])}]})
        self.assertNotEqual(nav.snap("L0", -0.05, 0.5), [-0.05, 0.5])
        self.assertIsNone(nav.snap("L0", -5.0, -5.0))


class MountFloor(unittest.TestCase):  # F6
    def test_mount_floor_props_keep_places(self):
        d = Path(tempfile.mkdtemp())
        synth_world.write(d)
        sp = json.loads((d / "scene.json").read_text())
        for p in sp["props"]:
            if p.get("solid", True) and not p.get("mount") and not p.get("on"):
                p["mount"] = "floor"
        (d / "scene.json").write_text(json.dumps(sp))
        names = {p["name"] for p in stage.build_places(d)["places"]}
        for want in ("sofa", "armchair", "table"):
            self.assertIn(want, names, sorted(names))


class ExpectTouchWorldRun(unittest.TestCase):  # F7
    def test_numbers_match_world_run(self):
        exp = json.loads((DATA / "expect_touch.json").read_text())
        a = next(p for p in stage.build_places(str(WORLD_RUN))["places"]
                 if p["id"] == "living_armchair")
        c1, c2 = exp["cases"][:2]
        self.assertAlmostEqual(c1["target"][0], a["at"][0], delta=0.05)
        self.assertAlmostEqual(c1["target"][1], a["at"][1], delta=0.05)
        self.assertAlmostEqual(c1["yaw"], a["yaw"], delta=2)
        self.assertAlmostEqual(c2["target"][0], a["at"][0] - 0.8, delta=0.05)
        self.assertAlmostEqual(c2["target"][1], a["at"][1], delta=0.05)


class SizeKept(unittest.TestCase):  # F8
    def test_places_keep_size(self):
        res = stage.build_places(str(WORLD_RUN))
        scene = json.loads((WORLD_RUN / "scene.json").read_text())
        sizes = {p["id"]: p["size"] for p in scene["props"]}
        for p in res["places"]:
            if p["kind"] == "door":
                continue
            base = p["id"].split(".")[0]
            self.assertEqual(p.get("size"), sizes[base], p["id"])
        copies = [p for p in res["places"] if p["id"].startswith("kitchen_stool.")]
        self.assertTrue(copies)
        for p in copies:
            self.assertEqual(p["size"], sizes["kitchen_stool"], p["id"])


class StartMap(unittest.TestCase):  # F9
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def test_write_stage_maps_cast_to_places(self):
        d = Path(tempfile.mkdtemp())
        synth_world.write(d / "world" / "run")
        shutil.copytree(DATA / "cast", d / "cast")
        out = d / "stage"
        out.mkdir()
        sj = stage.write_stage(d, out, brief={"mode": "seed"})
        names = {p["name"] for p in json.loads((out / "places.json").read_text())["places"]}
        cast = json.loads((d / "cast" / "cast.json").read_text())
        self.assertTrue(cast)
        self.assertEqual(set(sj["start"]), set(cast), sj["start"])
        for who, place in sj["start"].items():
            self.assertIn(place, names, (who, place))


class NarratorVoice(unittest.TestCase):  # stage.json carries book.json narrator_voice
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def test_write_stage_book_takes_voice_from_book(self):
        d = Path(tempfile.mkdtemp())
        synth_world.write(d / "world" / "run")
        out = d / "stage"
        out.mkdir()
        sj = stage.write_stage(d, out, brief={"mode": "book", "book": {"dir": str(JANE), "scene": "tea"}})
        self.assertEqual(sj["narrator_voice"], "woman", sj["narrator_voice"])

    def test_write_stage_seed_voice_is_none(self):
        d = Path(tempfile.mkdtemp())
        synth_world.write(d / "world" / "run")
        out = d / "stage"
        out.mkdir()
        sj = stage.write_stage(d, out, brief={"mode": "seed"})
        self.assertIsNone(sj["narrator_voice"])


if __name__ == "__main__":
    unittest.main()
