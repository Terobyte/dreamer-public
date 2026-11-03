"""B77: English book playback must reject a missing score artifact."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from make import play


class MissingScore(unittest.TestCase):
    def _setup(self, run_dir, score=None):
        story_dir = run_dir / "story"
        stage_dir = run_dir / "stage"
        story_dir.mkdir(parents=True)
        stage_dir.mkdir()
        if score is not None:
            (story_dir / "score.json").write_text(json.dumps(score))
        (stage_dir / "stage.json").write_text(json.dumps({
            "mode": "book", "book": {"dir": str(run_dir / "book"), "scene": "s1"},
            "objects": [], "narrator_voice": None,
        }))
        sim = SimpleNamespace(
            load_profile=lambda profile: {},
            _load_book_plan=lambda book, scenes, score: {"scenes": [{"dict": {}, "beats": []}]},
            run=lambda **kwargs: kwargs,
        )
        patches = [
            mock.patch.object(play, "_dream", lambda: None),
            mock.patch.dict(sys.modules, {
                "sim": sim,
                "dialogue": SimpleNamespace(Dialogue=lambda *a, **k: SimpleNamespace(background=True)),
                "fake": SimpleNamespace(FakeTransport=lambda *a, **k: object()),
            }),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_english_play_rejects_missing_score(self):
        with tempfile.TemporaryDirectory() as t:
            self._setup(Path(t))
            with self.assertRaisesRegex(FileNotFoundError, "score.json"):
                play.play(Path(t), fake=True)

    def test_english_play_accepts_present_score(self):
        with tempfile.TemporaryDirectory() as t:
            score = {"scene": "s1", "beats": []}
            self._setup(Path(t), score)
            self.assertEqual(play.play(Path(t), fake=True)["score"], score)


if __name__ == "__main__":
    unittest.main()
