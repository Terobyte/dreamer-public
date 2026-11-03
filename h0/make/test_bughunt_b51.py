# B51: the director cache written during `story` must survive core._publish
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from make import core


class StoryCacheSurvivesPublish(unittest.TestCase):
    def test_story_director_cache_survives_publish(self):
        from make import story as story_mod
        with tempfile.TemporaryDirectory() as t:
            tmp_path = Path(t)
            bookdir = tmp_path / "book"
            bookdir.mkdir()
            (bookdir / "book.txt").write_text("Anna walked in.\n\nShe sat down.\n", encoding="utf-8")
            (bookdir / "book.json").write_text(json.dumps({
                "title": "t", "pov": "Anna", "narrator_voice": "man",
                "cast": {"Anna": {"voice": "woman", "sex": "woman", "age": 20, "look": "a woman"}},
                "places": {"home": {"desc": "room", "exits": []}},
                "chapters": [{"n": 1, "file": "book.txt", "title": "One",
                              "scenes": [{"id": "s1", "paras": [0, 1], "place": "home", "cast": ["Anna"]}]}],
            }), encoding="utf-8")
            run_dir = tmp_path / "run"
            (run_dir / "brief").mkdir(parents=True)
            (run_dir / "brief" / "brief.json").write_text(json.dumps(
                {"mode": "book", "book": {"dir": str(bookdir), "scene": "s1"}}))
            tmp = run_dir / "story.tmp"          # same layout core.run_make uses
            tmp.mkdir()
            # a live run (the director is stubbed): a fake run's empty staging is never cached
            ctx = SimpleNamespace(run_dir=run_dir, out=tmp, params={}, opts={}, usd=0.0,
                                  spend=lambda usd: None)
            stub = lambda ctx: (lambda prompt: json.dumps({"start": [], "stage": []}))
            with mock.patch.object(story_mod, "_spark_director", stub):
                story_mod.run_story(ctx)
            # the cache is written into ctx.out (what gets published), not beside it
            self.assertTrue(list(tmp.glob("stage_*.json")), "staging wrote no stage_*.json into ctx.out")
            core._publish(run_dir, "story", tmp)
            self.assertTrue(list((run_dir / "story").glob("stage_*.json")),
                            "stage_<hash>.json cache was destroyed by _publish")


if __name__ == "__main__":
    unittest.main()
