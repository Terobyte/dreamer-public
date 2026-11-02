"""B77: English book playback must reject a missing score artifact."""
import json
import sys
from types import SimpleNamespace

import pytest

from make import play


def _setup(monkeypatch, run_dir, score=None):
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
    monkeypatch.setattr(play, "_dream", lambda: None)
    sim = SimpleNamespace(
        load_profile=lambda profile: {},
        _load_book_plan=lambda book, scenes, score: {"scenes": [{"dict": {}, "beats": []}]},
        run=lambda **kwargs: kwargs,
    )
    monkeypatch.setitem(sys.modules, "sim", sim)
    monkeypatch.setitem(sys.modules, "dialogue", SimpleNamespace(
        Dialogue=lambda *a, **k: SimpleNamespace(background=True)))
    monkeypatch.setitem(sys.modules, "fake", SimpleNamespace(FakeTransport=lambda *a, **k: object()))
    return sim


def test_english_play_rejects_missing_score(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    with pytest.raises(FileNotFoundError, match="score.json"):
        play.play(tmp_path, fake=True)


def test_english_play_accepts_present_score(monkeypatch, tmp_path):
    score = {"scene": "s1", "beats": []}
    sim = _setup(monkeypatch, tmp_path, score)
    result = play.play(tmp_path, fake=True)
    assert result["score"] == score
