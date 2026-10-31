"""Red tests for blocking findings F1-F5 (phase contract world/story)."""
import json
import os
import shutil
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import core, story

DATA = Path(__file__).resolve().parent / "testdata"
JANE = str(Path(__file__).resolve().parents[1] / "dream" / "books" / "jane-eyre")


class NoNet(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network"))
        p.start()
        self.addCleanup(p.stop)


class Versions(NoNet):
    def test_world_story_stage_bumped(self):
        st = core.default_stages()
        for sid in ("world", "story", "stage"):
            self.assertGreaterEqual(st[sid].version, 2, sid)


class FreshKeepsWorldTmp(NoNet):
    def _stages(self):
        def ok(ctx):
            (ctx.out / "marker.txt").write_text("{}")
            return 0.0
        return {"refs": core.Stage("refs", (), 1, ok, ()),
                "world": core.Stage("world", ("refs",), 1, ok, ())}

    def test_from_refs_fresh_keeps_tmp(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            (run / "world.tmp").mkdir(parents=True)
            (run / "world.tmp" / "sentinel").write_text("x")
            res = core.run_make(run, "p", stages=self._stages(), from_="refs", fresh=True)
            self.assertEqual(res["world"], "ran")
            self.assertTrue((run / "world" / "sentinel").is_file())

    def test_from_world_fresh_resets_tmp(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            core.run_make(run, "p", stages=self._stages(), from_="refs")
            (run / "world.tmp").mkdir(parents=True)
            (run / "world.tmp" / "sentinel").write_text("x")
            core.run_make(run, "p", stages=self._stages(), from_="world", fresh=True)
            self.assertFalse((run / "world" / "sentinel").is_file())


class StoryHash(NoNet):
    def _run_until_story(self, run, book):
        return core.run_make(run, "p", fake=True, until="story", book=book, scene="tea")

    def test_edited_score_reruns_story(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            r1 = self._run_until_story(run, JANE)
            self.assertEqual(r1["story"], "ran", r1)
            ed = {"scene": "tea", "beats": [{"kind": "narration", "text": "mine"}]}
            (run / "story" / "score.edited.json").write_text(json.dumps(ed))
            r2 = core.run_make(run, "p", fake=True, only="story")
            self.assertEqual(r2["story"], "ran", r2)
            self.assertEqual(json.loads((run / "story" / "score.json").read_text()), ed)

    def test_chapter_change_reruns_story(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / "book"
            shutil.copytree(JANE, book)
            run = Path(tmp) / "run"
            r1 = self._run_until_story(run, str(book))
            self.assertEqual(r1["story"], "ran", r1)
            ch = book / "ch13.txt"
            ch.write_text(ch.read_text() + "\n")
            r2 = core.run_make(run, "p", fake=True, only="story")
            self.assertEqual(r2["story"], "ran", r2)


class RunSimPublished(NoNet):
    def test_published_stage_passes_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            (run / "story").mkdir(parents=True)
            score = {"scene": "tea", "beats": [{"kind": "line", "who": "Jane Eyre", "text": "hi"}]}
            (run / "story" / "score.json").write_text(json.dumps(score))
            real = run / ".pub" / "stage-1"
            real.mkdir(parents=True)
            sj = {"freestyle": False, "mode": "book",
                  "book": {"dir": "x", "scene": "tea", "score": "story/score.json"}}
            (real / "stage.json").write_text(json.dumps(sj))
            os.symlink(os.path.relpath(real, run), run / "stage")
            got = {}
            story.run_sim(run / "stage" / "stage.json",
                          run=lambda **kw: got.update(kw) or None)
            self.assertEqual(got.get("score"), score)
            self.assertEqual(got.get("scenes"), ["tea"])


class FakeFixture(NoNet):
    def test_fixture_has_rooms_props_and_dist(self):
        sc = json.loads((DATA / "world_run" / "scene.json").read_text())
        self.assertEqual(len(sc["rooms"]), 2)
        self.assertGreaterEqual(len(sc.get("props", [])), 5)
        self.assertTrue((DATA / "world_run" / "dist" / "geometry.json").is_file())
        self.assertTrue((DATA / "world_run" / "dist" / "nav.json").is_file())


if __name__ == "__main__":
    unittest.main()
