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
