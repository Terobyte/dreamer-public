# B51: the director cache written during `story` must survive core._publish
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

from make import core


def test_story_director_cache_survives_publish(tmp_path):
    from make import story as story_mod
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
    ctx = SimpleNamespace(run_dir=run_dir, out=tmp, params={"fake": True}, opts={}, usd=0.0)
    story_mod.run_story(ctx)
    written = list(run_dir.glob("story/stage_*.json"))
    assert written, "setup: staging wrote no stage_*.json cache (cannot test B51)"
    core._publish(run_dir, "story", tmp)
    left = list((run_dir / "story").glob("stage_*.json"))
    assert left, "expected stage_<hash>.json cache to survive _publish, but it was destroyed (found none)"
