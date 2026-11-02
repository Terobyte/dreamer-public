# gate wiring: runs under tools/ptest.py (unittest) as make.test_bughunt_bNN with cwd h0
# B14: `story` must stage a book scene with the place bank built from the world, not places=None.
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from . import core
from .testdata import synth_world


def _make_ctx(run_dir, out_dir, book_dir="bookdir", scene="s1"):
    class Ctx:
        pass
    ctx = Ctx()
    ctx.run_dir = Path(run_dir)
    ctx.out = Path(out_dir)
    ctx.params = {"fake": True}
    ctx.opts = {}
    brief = {"mode": "book", "book": {"dir": book_dir, "scene": scene}}
    (Path(run_dir) / "brief").mkdir(parents=True, exist_ok=True)
    (Path(run_dir) / "brief" / "brief.json").write_text(json.dumps(brief))
    (Path(run_dir) / "story").mkdir(parents=True, exist_ok=True)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    return ctx


class BughuntB14(unittest.TestCase):
    def test_story_depends_on_world(self):
        self.assertIn("world", core.default_stages()["story"].deps)

    def test_story_builds_places_from_world_on_clean_run(self):
        from make import story as story_mod
        with tempfile.TemporaryDirectory() as d:
            run_dir, out_dir = Path(d) / "run", Path(d) / "out"
            ctx = _make_ctx(run_dir, out_dir)
            synth_world.write(run_dir / "world" / "run", glb=False)
            # clean run: the later `stage` stage has not written places.json
            self.assertFalse((run_dir / "stage" / "places.json").is_file())
            self.assertTrue((run_dir / "world" / "run" / "dist" / "geometry.json").is_file())

            captured = {}
            fake_book = types.ModuleType("book")

            def fake_score_scene(dir_, scene, places=None, director=None, cache_dir=None):
                captured["places"] = places
                return {"scene": scene, "beats": []}
            fake_book.score_scene = fake_score_scene
            with mock.patch.dict(sys.modules, {"book": fake_book}):
                rc = story_mod.run_story(ctx)
            self.assertEqual(rc, 0.0)
            places = captured.get("places")
            self.assertIsNotNone(places, "B14: run_story staged with places=None on a clean run")
            self.assertIsInstance(places, dict)
            self.assertTrue(places.get("places"), "place bank is empty")
