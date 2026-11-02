"""B78: report make.play's early process exit instead of a record timeout."""
from types import SimpleNamespace

import pytest

from make import film


class DeadPlay:
    stdout = object()

    def __init__(self, code):
        self.code = code
        self.polled = False

    def poll(self):
        self.polled = True
        return self.code

    def terminate(self):
        pass

    def wait(self, timeout=None):
        return self.code


def _record_with_fake_process(monkeypatch, tmp_path, process_code, record_code=1):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "world" / "run" / "dist").mkdir(parents=True)
    process = DeadPlay(process_code)
    calls = []

    def fake_run(*args, **kwargs):
        calls.append(args[0])
        return SimpleNamespace(returncode=0 if len(calls) == 1 else record_code)

    monkeypatch.setattr(film.subprocess, "Popen", lambda *a, **k: process)
    monkeypatch.setattr(film.subprocess, "run", fake_run)
    monkeypatch.setattr(film, "_free_port", lambda: 1234)
    monkeypatch.setattr(film, "_lines", lambda proc: object())
    monkeypatch.setattr(film, "_next", lambda q, pred, timeout: "http://127.0.0.1/")
    monkeypatch.setattr(film, "page_url", lambda *a: "http://127.0.0.1/")
    return run_dir, process


def test_dead_play_process_is_reported_immediately(monkeypatch, tmp_path):
    run_dir, process = _record_with_fake_process(monkeypatch, tmp_path, process_code=7)
    with pytest.raises(RuntimeError, match="record.mjs exit 1.*600s"):
        film.record_scene(run_dir, tmp_path / "film.mp4", max_s=600)
    assert process.polled, (
        "expected make.play to be polled while record.mjs can wait up to 600s; "
        "actual record_scene entered the recorder's full 600s window without checking it"
    )


def test_live_play_process_keeps_record_failure_diagnostic(monkeypatch, tmp_path):
    run_dir, process = _record_with_fake_process(monkeypatch, tmp_path, process_code=None)
    with pytest.raises(RuntimeError, match="record.mjs exit 1"):
        film.record_scene(run_dir, tmp_path / "film.mp4")
    assert not process.polled
