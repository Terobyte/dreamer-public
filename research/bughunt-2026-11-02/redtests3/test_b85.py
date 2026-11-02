"""B85: prompt rotation must tolerate nonnumeric .txt entries."""

from types import SimpleNamespace

from director import Director
from fsm import BuildFSM


class CapturedThread:
    instances = []

    def __init__(self, *args, **kwargs):
        self.started = False
        self.__class__.instances.append(self)

    def start(self):
        self.started = True


def _director(tmp_path, monkeypatch):
    monkeypatch.setattr("director.threading.Thread", CapturedThread)
    CapturedThread.instances.clear()
    return Director(BuildFSM([], now=0.0), fake=True, outdir=str(tmp_path))


def test_nonnumeric_prompt_file_does_not_break_consult(tmp_path, monkeypatch):
    d = _director(tmp_path, monkeypatch)
    consult_dir = tmp_path / "consults"
    consult_dir.mkdir()
    (consult_dir / "notes.txt").write_text("unrelated note", encoding="utf-8")

    error = None
    try:
        d.consult_async(0.0)
    except Exception as exc:  # turn the observed crash into an assertion failure
        error = exc

    assert error is None, (
        "expected consult to tolerate nonnumeric .txt names; actual %s: %s"
        % (type(error).__name__, error)
    )
    assert d.fsm.in_flight is True
    assert CapturedThread.instances[-1].started is True


def test_numeric_only_prompt_directory_starts_consult(tmp_path, monkeypatch):
    d = _director(tmp_path, monkeypatch)

    ticket = d.consult_async(0.0)

    assert ticket is not None
    assert d.fsm.in_flight is True
    assert CapturedThread.instances[-1].started is True
