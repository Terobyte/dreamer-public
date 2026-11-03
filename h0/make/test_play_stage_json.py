"""stage.json is what make.play plays (debt sweep Nov 3): `make --lang ru` -> a plain `make.play RUN`
plays score.ru.json."""

import json
import tempfile
import unittest
from pathlib import Path

from make import play


class PlayReadsStageJson(unittest.TestCase):
    def test_lang_from_stage_json(self):
        d = Path(tempfile.mkdtemp())
        (d / "stage").mkdir()
        (d / "story").mkdir()
        (d / "stage" / "stage.json").write_text(json.dumps(
            {"mode": "book", "lang": "ru", "objects": [], "book": {"dir": "x", "scene": "s"}}))
        # no score.ru.json: the ru path must be the one asked for
        with self.assertRaisesRegex(FileNotFoundError, "score.ru.json"):
            play.play(d, fake=True, run=lambda **kw: (None, None))


if __name__ == "__main__":
    unittest.main()


class DistFromStageJson(unittest.TestCase):
    """stage.json `dist` is where the page is served from; old runs without it keep world/run/dist."""

    def _run(self, sj):
        d = Path(tempfile.mkdtemp())
        (d / "stage").mkdir()
        if sj is not None:
            (d / "stage" / "stage.json").write_text(json.dumps(sj))
        return d

    def test_field_moves_the_page_and_the_stage_path(self):
        from make import play
        d = self._run({"dist": "w/dist", "mode": "seed"})
        self.assertEqual(play.dist_of(d), "w/dist")
        url = play.static_url(d, 1, 2)
        self.assertIn(":1/w/dist/index.html", url)
        self.assertIn("stage=../../stage/stage.json", url)

    def test_default_and_unsafe_values(self):
        from make import play
        self.assertEqual(play.dist_of(self._run(None)), "world/run/dist")
        self.assertEqual(play.dist_of(self._run({"mode": "seed"})), "world/run/dist")
        self.assertEqual(play.dist_of(self._run({"dist": "/etc"})), "world/run/dist")
        self.assertEqual(play.dist_of(self._run({"dist": "../x"})), "world/run/dist")
        url = play.static_url(self._run({"dist": "world/run/dist"}), 1, 2)
        self.assertIn("stage=../../../stage/stage.json", url)
