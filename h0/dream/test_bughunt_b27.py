# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
import json
import tempfile
from pathlib import Path
import os
import pytest
import dub


def _write_log(run):
    rows = [
        {"type": "line", "text": "hello one", "who": "hero", "role": "hero"},
        {"type": "line", "text": "hello two", "who": "hero", "role": "hero"},
    ]
    with open(os.path.join(run, "log.jsonl"), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


class FlakyVoice:
    def __init__(self):
        self.calls = 0

    def synthesize(self, text, label, path):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("TTS API timeout")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"wav")
        return {"ok": True, "audio": path, "pause": 1.0}


class GoodVoice:
    def __init__(self):
        self.calls = 0

    def synthesize(self, text, label, path):
        self.calls += 1
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"wav")
        return {"ok": True, "audio": path, "pause": 1.0}


def test_retry_after_crash_continues_voicing(tmp_path, monkeypatch):
    run = str(tmp_path)
    _write_log(run)
    monkeypatch.setattr(dub, "cast_of", lambda scene, profile="A": ("hero", {"hero": "man"}, {}, "place", {}))

    with pytest.raises(RuntimeError, match="TTS API timeout"):
        dub.dub(run, "scene", voice=FlakyVoice(), images=False)

    # crash happened mid-synthesis: backup marker already created
    assert os.path.exists(os.path.join(run, "log.jsonl.novoice"))

    # restart with healthy TTS must voice the lines, not instantly return (0, 0)
    n2, _ = dub.dub(run, "scene", voice=GoodVoice(), images=False)
    assert n2 == 2, f"retry blocked by early .novoice marker, got ({n2}) instead of voicing 2 lines"


class BughuntB27(unittest.TestCase):
    def test_b27(self):
        with tempfile.TemporaryDirectory() as d, pytest.MonkeyPatch.context() as mp:
            test_retry_after_crash_continues_voicing(Path(d), mp)
