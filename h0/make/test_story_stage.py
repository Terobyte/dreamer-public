"""N10: make.story wires the real staging director and its per-run cache."""
import json
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import stage, story
from make.testdata import synth_world
from make.test_story import BOOK, JANE, NoNet, _ctx, _prep

if str(story.DREAM) not in sys.path:
    sys.path.insert(0, str(story.DREAM))
import book


class StoryDirector(NoNet):
    def test_non_fake_run_passes_real_director_and_run_cache_to_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            run, out = _prep(tmp, BOOK)
            synth_world.write(run / "world" / "run", glb=False)
            places = stage.build_places(run / "world" / "run")
            ctx = _ctx(run, out)
            seen = {}

            def score_scene(book_dir, scene_id, **kw):
                seen.update(kw)
                return {"scene": scene_id, "beats": []}

            director_fn = lambda prompt: '{"start":[],"stage":[]}'
            with mock.patch.object(book, "score_scene", side_effect=score_scene), \
                 mock.patch.object(story, "_spark_director", return_value=director_fn, create=True) as factory:
                story.run_story(ctx)
            self.assertTrue(factory.called, "live book scoring must construct the Spark director")
            self.assertIs(seen.get("director"), director_fn)
            self.assertEqual(seen.get("places"), places)
            self.assertEqual(seen.get("cache_dir"), run / "story")

    def test_second_identical_run_hits_stage_cache_without_director_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            brief = dict(BOOK, book={"dir": JANE, "scene": "tea"})
            run, first_out = _prep(tmp, brief)
            synth_world.write(run / "world" / "run", glb=False)
            calls = []
            response = '{"start":[],"stage":[]}'
            def director_fn(prompt):
                calls.append(prompt)
                return response
            with mock.patch.object(story, "_spark_director", return_value=director_fn, create=True):
                story.run_story(_ctx(run, first_out))
                second_out = run / "story-second.tmp"
                second_out.mkdir()
                story.run_story(_ctx(run, second_out))
            # the same Spark director also writes line tones (dream/voice_tone); count the staging prompts only
            calls = [c for c in calls if "Determine staging" in c]
            self.assertEqual(len(calls), 1, "the second score must reuse the director cache")
            cache_files = list((run / "story").glob("stage_*.json"))
            self.assertEqual(len(cache_files), 1)
            self.assertRegex(cache_files[0].name, r"^stage_[0-9a-f]{64}\.json$")


if __name__ == "__main__":
    unittest.main()
