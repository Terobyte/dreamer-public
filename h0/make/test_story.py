"""M3: stage `story` - book score / seed, --freestyle reaches sim.run."""
import json
import shutil
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import core, story

H0 = Path(__file__).resolve().parents[1]
JANE = str(H0 / "dream" / "books" / "jane-eyre")


class NoNet(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network"))
        p.start()
        self.addCleanup(p.stop)


def _prep(tmp, brief):
    run = Path(tmp) / "run"
    (run / "brief").mkdir(parents=True)
    (run / "brief" / "brief.json").write_text(json.dumps(brief))
    out = run / "story.tmp"
    out.mkdir()
    return run, out


def _ctx(run, out, **kw):
    return core.Ctx(run, out, {}, False, None, kw.get("opts", {}))


BOOK = {"mode": "book", "book": {"dir": JANE, "scene": "tea"}, "scene": {"where": "hall", "who": [], "want": "x"}}
SEED = {"mode": "seed", "book": None, "scene": {"where": "room1", "who": ["Anna"], "want": "look\naround  now"}}


class Story(NoNet):
    def test_book_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            run, out = _prep(tmp, BOOK)
            story.run_story(_ctx(run, out))
            sc = json.loads((out / "score.json").read_text())
            self.assertEqual(sc["scene"], "tea")
            self.assertGreaterEqual(sum(b["kind"] == "line" for b in sc["beats"]), 20)

    def test_edited_same_scene_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            run, out = _prep(tmp, BOOK)
            (run / "story").mkdir()
            ed = {"scene": "tea", "beats": [{"kind": "narration", "text": "mine"}]}
            (run / "story" / "score.edited.json").write_text(json.dumps(ed))
            story.run_story(_ctx(run, out))
            self.assertEqual(json.loads((out / "score.json").read_text()), ed)
            self.assertEqual(json.loads((out / "score.edited.json").read_text()), ed)

    def test_edited_other_scene_is_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            run, out = _prep(tmp, BOOK)
            (run / "story").mkdir()
            (run / "story" / "score.edited.json").write_text(json.dumps({"scene": "other", "beats": []}))
            with self.assertRaises(ValueError):
                story.run_story(_ctx(run, out))

    def test_seed_one_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            run, out = _prep(tmp, SEED)
            story.run_story(_ctx(run, out))
            self.assertEqual((out / "seed.txt").read_text(), "look around now\n")
            self.assertFalse((out / "score.json").exists())


class Freestyle(NoNet):
    def test_flag_not_in_stage_json_but_reaches_sim_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            (run / "brief").mkdir(parents=True)
            (run / "brief" / "brief.json").write_text(json.dumps(BOOK))
            res = core.run_make(run, "p", fake=True, until="stage", freestyle=True,
                                book=JANE, scene="tea")
            self.assertEqual(res["stage"], "ran", res)
            sj = json.loads((run / "stage" / "stage.json").read_text())
            self.assertNotIn("freestyle", sj)
            self.assertEqual(sj["mode"], "book")
            got = {}
            story.run_sim(run / "stage" / "stage.json", run=lambda **kw: got.update(kw),
                          freestyle=True)
            self.assertIs(got["freestyle"], True)
            self.assertEqual(got["scenes"], ["tea"])

    def test_default_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            core.run_make(run, "a room", fake=True, until="stage")
            sj = json.loads((run / "stage" / "stage.json").read_text())
            self.assertNotIn("freestyle", sj)
            got = {}
            story.run_sim(run / "stage" / "stage.json",
                          run=lambda **kw: got.update(kw) or None)
            self.assertIs(got["freestyle"], False)


class NarratorFallback(NoNet):
    def test_stage_falls_back_without_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / "book"
            shutil.copytree(JANE, book)
            bj = json.loads((book / "book.json").read_text())
            bj.pop("narrator_voice", None)
            (book / "book.json").write_text(json.dumps(bj))
            run = Path(tmp) / "run"
            res = core.run_make(run, "p", fake=True, until="stage",
                                book=str(book), scene="tea")
            self.assertEqual(res["stage"], "ran", res)
            sj = json.loads((run / "stage" / "stage.json").read_text())
            self.assertEqual(sj["narrator_voice"], "old_man")


if __name__ == "__main__":
    unittest.main()
