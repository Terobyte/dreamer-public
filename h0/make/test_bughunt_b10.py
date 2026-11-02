# gate wiring: runs under tools/ptest.py (unittest) as make.test_bughunt_bNN with cwd h0
import tempfile
import unittest
import json
from pathlib import Path
from types import SimpleNamespace

from make import book as bookmod


def _make_book():
    return {
        "title": "t",
        "pov": "Hero",
        "narrator_voice": "man",
        "cast": {"Hero": {"sex": "woman", "age": 9, "look": "a small girl in a red coat"}},
        "places": {"home": {"desc": "a small room", "exits": ["yard"]}},
        "chapters": [
            {"n": 1, "file": "book.txt", "title": "One",
             "scenes": [{"id": "s1", "paras": [0, 1], "place": "home", "cast": ["Hero"]}]},
            {"n": 2, "file": "ch1.txt", "title": "Two",
             "scenes": [{"id": "s2", "paras": [0, 1], "place": "home", "cast": ["Hero"]}]},
        ],
    }


def test_voices_preserves_chapter_files(tmp_path):
    read_dir = tmp_path / "read"
    out_dir = tmp_path / "voices"
    read_dir.mkdir()
    out_dir.mkdir()
    (read_dir / "book.txt").write_text("para one", encoding="utf-8")
    (read_dir / "ch1.txt").write_text("para two", encoding="utf-8")
    (read_dir / "book.json").write_text(json.dumps(_make_book()), encoding="utf-8")

    ctx = SimpleNamespace(
        prev=lambda step: read_dir if step == "read" else tmp_path / step,
        out=out_dir,
    )
    bookmod._step_voices(ctx)

    assert (out_dir / "ch1.txt").is_file(), "voices must preserve ch1.txt for load_book on world step"


class BughuntB10(unittest.TestCase):
    def test_b10(self):
        with tempfile.TemporaryDirectory() as d:
            test_voices_preserves_chapter_files(Path(d))
