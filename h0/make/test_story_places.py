"""Eyes-C G1: `story` stages a book scene with places built from world/run, never from stage/places.json."""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from . import core
from .testdata import synth_world


def _world_with_bed(root):
    synth_world.write(root, glb=False)
    root = Path(root)
    sc = json.loads((root / "scene.json").read_text())
    size = {"w": 1.6, "h": 0.5, "d": 2.0}
    sc["props"].append({"id": "living_bed", "room": "living", "yaw": 0.0, "size": size, "at": [3.0, 3.0]})
    (root / "scene.json").write_text(json.dumps(sc))
    geo = json.loads((root / "dist" / "geometry.json").read_text())
    geo["meshes"].append({"id": "living_bed", "kind": "prop", "room": "living",
                          "positions": synth_world._box(3.0, 3.0, size["w"], size["d"], size["h"])})
    (root / "dist" / "geometry.json").write_text(json.dumps(geo))


class _Ctx:
    def __init__(self, run_dir, out):
        self.run_dir, self.out = Path(run_dir), Path(out)
        self.params, self.opts = {"fake": True}, {}


def _ctx(tmp, world=True, edited=None):
    run, out = Path(tmp) / "run", Path(tmp) / "out"
    (run / "brief").mkdir(parents=True)
    (run / "story").mkdir()
    out.mkdir()
    (run / "brief" / "brief.json").write_text(json.dumps(
        {"mode": "book", "book": {"dir": "bookdir", "scene": "s1"}}))
    if world:
        _world_with_bed(run / "world" / "run")
    if edited:
        (run / "story" / "score.edited.json").write_text(json.dumps(edited))
    return _Ctx(run, out)


def _run(ctx, score=None):
    seen = {}

    def score_scene(dir_, scene, places=None, director=None, cache_dir=None):
        seen["places"] = places
        return score if score is not None else {"scene": scene, "beats": [], "warnings": []}
    book = types.ModuleType("book")
    book.score_scene = score_scene
    with mock.patch.dict(sys.modules, {"book": book}):
        from make import story
        story.run_story(ctx)
    return seen


class StoryPlaces(unittest.TestCase):
    def test_places_from_world_run_with_bed(self):
        from make import stage
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _ctx(tmp)
            seen = _run(ctx)
            want = stage.build_places(ctx.run_dir / "world" / "run")
            self.assertEqual(seen["places"], want)
            self.assertIn("bed", [p["name"] for p in seen["places"]["places"]])

    def test_stage_places_json_is_not_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _ctx(tmp, world=False)
            (ctx.run_dir / "stage").mkdir()
            (ctx.run_dir / "stage" / "places.json").write_text(json.dumps({"places": [{"name": "x"}], "warnings": []}))
            self.assertIsNone(_run(ctx)["places"])

    def test_no_world_none_and_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _ctx(tmp, world=False)
            seen = _run(ctx)
            self.assertIsNone(seen["places"])
            score = json.loads((ctx.out / "score.json").read_text())
            self.assertIn("story: no world, staging without places", score["warnings"])

    def test_edited_score_taken_verbatim_without_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            ed = {"scene": "s1", "beats": [], "warnings": ["mine"]}
            ctx = _ctx(tmp, world=False, edited=ed)
            _run(ctx)
            self.assertEqual(json.loads((ctx.out / "score.json").read_text()), ed)

    def test_deps_and_missing_world(self):
        self.assertEqual(core.default_stages()["story"].deps, ("refs", "world"))
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            with self.assertRaises(core.MissingInput):
                core.run_make(run, "p", only="story", fake=True)
            self.assertFalse((run / "story").exists(), "story must not start without world")

    def test_fresh_fake_pipeline_places_from_world_before_stage(self):
        """Fresh --fake run: score_scene gets places from build_places(world/run) with bed before stage."""
        import dataclasses
        import time

        from make.test_story import BOOK as _BOOK

        JANE = _BOOK["book"]["dir"]
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            seen = {}
            events = []

            def fake_score_scene(dir_, scene, places=None, director=None, cache_dir=None):
                events.append(("score_scene", time.time()))
                seen["places"] = places
                return {"scene": scene, "beats": [], "warnings": []}

            fake_book = types.ModuleType("book")
            fake_book.score_scene = fake_score_scene

            def _fake_load_book(d):
                return {}
            fake_book.load_book = _fake_load_book

            # world fixture must contain bed (scene.json + dist/geometry.json + dist/nav.json)
            # default copy lacks bed, so inject via custom world stage
            def fake_world(ctx):
                wo = ctx.out / "run"
                _world_with_bed(wo)
                (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time()}))
                return 0.0

            stages = core.default_stages()
            stages["world"] = dataclasses.replace(stages["world"], fn=fake_world)
            orig_stage_fn = stages["stage"].fn

            def spy_stage(ctx):
                events.append(("stage", time.time()))
                return orig_stage_fn(ctx)
            stages["stage"] = dataclasses.replace(stages["stage"], fn=spy_stage)

            with mock.patch.dict(sys.modules, {"book": fake_book}):
                res = core.run_make(run, "p", stages=stages, until="stage", fake=True, book=JANE, scene="tea")
            self.assertEqual(res.get("stage"), "ran", "stage must start after story")
            self.assertIn("bed", [p["name"] for p in (seen.get("places") or {}).get("places", [])],
                          "fresh run must pass bed place from world/run")
            from make import stage as stage_mod
            want = stage_mod.build_places(run / "world" / "run")
            self.assertEqual(seen.get("places"), want)
            # order: score_scene must be called before stage stage starts (not just finishes)
            self.assertGreaterEqual(len(events), 2, "both score_scene and stage must be recorded")
            order = [e[0] for e in events]
            self.assertIn("score_scene", order, "score_scene must be called")
            self.assertIn("stage", order, "stage must run")
            self.assertLess(order.index("score_scene"), order.index("stage"),
                            "score_scene must be called before stage starts")

    def test_world_change_changes_story_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            core.run_make(run, "p", until="world", fake=True)
            stages = core.default_stages()
            calls = []
            real = core.input_hash

            def spy(sid, *a):
                h = real(sid, *a)
                if sid == "story":
                    calls.append(h)
                return h
            with mock.patch.object(core, "input_hash", spy):
                core.run_make(run, "p", only="story", fake=True)
                scene = run / "world" / "run" / "scene.json"
                if not scene.is_file():
                    scene.parent.mkdir(parents=True, exist_ok=True)
                scene.write_text(scene.read_text() + " " if scene.is_file() else "{}")
                core.run_make(run, "p", only="story", fake=True)
            self.assertEqual(len(calls), 2)
            self.assertNotEqual(calls[0], calls[1])


if __name__ == "__main__":
    unittest.main()
