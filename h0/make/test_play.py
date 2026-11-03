"""Phase M4 red: `make/play.py --fake` writes log.jsonl in book, book+freestyle and seed modes."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import play, stage
from .testdata import synth_world

DATA = Path(__file__).resolve().parent / "testdata"
DREAM = Path(__file__).resolve().parents[1] / "dream"
JANE = str(DREAM / "books" / "jane-eyre")
EXPECT = json.loads((DATA / "expect_touch.json").read_text())
REMARK = EXPECT["cases"][2]["narrator"]


def _rows(log):
    return [json.loads(l) for l in Path(log).read_text().splitlines() if l.strip()]


def _run_dir(brief):
    d = Path(tempfile.mkdtemp())
    synth_world.write(d / "world" / "run")
    (d / "story").mkdir()
    if brief["mode"] == "seed":
        (d / "story" / "seed.txt").write_text("two strangers meet in a small house\n")
    else:
        sys.path.insert(0, str(DREAM))
        import book
        score = book.score_scene(JANE, brief["book"]["scene"])
        (d / "story" / "score.json").write_text(json.dumps(score))
    (d / "stage").mkdir()
    stage.write_stage(d, d / "stage", brief=brief)
    return d


class PlayFake(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def test_seed_logs_touch_armchair(self):
        d = _run_dir({"mode": "seed", "book": None})
        _, log = play.play(d, fake=True)
        rows = _rows(log)
        self.assertTrue(rows)
        self.assertTrue(any((r["type"], r.get("label")) == ("consult", "seed") for r in rows))
        self.assertTrue(any(r.get("touch") == "armchair" for r in rows), [r.get("type") for r in rows])

    def test_book_logs_narrator_remark(self):
        d = _run_dir({"mode": "book", "book": {"dir": JANE, "scene": "tea"}})
        _, log = play.play(d, fake=True)
        rows = _rows(log)
        self.assertTrue(rows)
        self.assertTrue(any(r.get("type") == "narrator" and REMARK in r.get("text", "") for r in rows))

    def test_book_freestyle_logs(self):
        d = _run_dir({"mode": "book", "book": {"dir": JANE, "scene": "tea"}})
        _, log = play.play(d, fake=True, freestyle=True)
        rows = _rows(log)
        self.assertTrue(any(r.get("type") == "mode" and r.get("mode") == "freestyle" for r in rows))

    def test_objects_are_the_places(self):
        d = _run_dir({"mode": "seed", "book": None})
        sj = json.loads((d / "stage" / "stage.json").read_text())
        self.assertIn("armchair", sj["objects"])
        self.assertEqual(play.static_url(d, 8123, 8124),
                         "http://127.0.0.1:8123/world/run/dist/index.html"
                         "?sim=http://127.0.0.1:8124&stage=../../../stage/stage.json")


if __name__ == "__main__":
    unittest.main()
