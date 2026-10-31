"""Red tests for F6/F7/F8 (world fixture depth, nested chapter hash, build script)."""
import json
import shutil
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import core

DATA = Path(__file__).resolve().parent / "testdata"
JANE = str(Path(__file__).resolve().parents[1] / "dream" / "books" / "jane-eyre")


class NoNet(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network"))
        p.start()
        self.addCleanup(p.stop)


class FixtureDepth(NoNet):
    def test_geometry_has_meshes_and_floors(self):
        g = json.loads((DATA / "world_run" / "dist" / "geometry.json").read_text())
        self.assertTrue(g.get("meshes"), "geometry needs meshes")
        self.assertTrue(g.get("floors"), "geometry needs floors")

    def test_scene_door_leaf_and_prop_sizes(self):
        sc = json.loads((DATA / "world_run" / "scene.json").read_text())
        self.assertTrue(sc["doors"], "need a door")
        self.assertIn("leaf", sc["doors"][0], "door needs leaf data")
        for p in sc.get("props", []):
            self.assertIn("size_m", p, f"prop {p.get('id')} needs size_m")


class NestedChapterHash(NoNet):
    def test_nested_chapter_change_reruns_story(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / "book"
            shutil.copytree(JANE, book)
            bj = json.loads((book / "book.json").read_text())
            (book / "chapters").mkdir()
            shutil.move(str(book / "ch13.txt"), str(book / "chapters" / "ch13.txt"))
            bj["chapters"][0]["file"] = "chapters/ch13.txt"
            (book / "book.json").write_text(json.dumps(bj, ensure_ascii=False, indent=2))
            run = Path(tmp) / "run"
            r1 = core.run_make(run, "p", fake=True, until="story", book=str(book), scene="tea")
            self.assertEqual(r1["story"], "ran", r1)
            ch = book / "chapters" / "ch13.txt"
            ch.write_text(ch.read_text() + "\n")
            r2 = core.run_make(run, "p", fake=True, only="story")
            self.assertEqual(r2["story"], "ran", r2)


class BuildScript(NoNet):
    def test_build_script_exists(self):
        self.assertTrue((DATA / "build_world_run.sh").is_file(), "need h0/make/testdata/build_world_run.sh")


if __name__ == "__main__":
    unittest.main()
