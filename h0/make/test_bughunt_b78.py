"""B78: a make.play that dies mid-scene stops the recording at once with its own exit code,
instead of record.mjs waiting out its whole max_s window for a book_end nobody sends.
(The hunter's repro asserted the old timeout message and forbade polling a live play,
so no fix could pass it; rewritten against the claim.)"""
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from make import film


class Play:
    stdout = ()

    def __init__(self, code):
        self.code = code

    def poll(self):
        return self.code

    def terminate(self):
        pass

    def wait(self, timeout=None):
        return self.code


class Recorder:
    """record.mjs: waits forever (the page never ends), or exits with `code` at once."""

    def __init__(self, code=None):
        self.code = code
        self.killed = False

    def wait(self, timeout=None):
        if self.killed or self.code is not None:
            return self.code
        time.sleep(min(timeout or 0, 0.01))
        raise subprocess.TimeoutExpired("record.mjs", timeout)

    def poll(self):
        return -9 if self.killed else self.code

    def kill(self):
        self.killed = True


class B78(unittest.TestCase):
    def _record(self, play, recorder):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        run_dir = Path(d.name) / "run"
        (run_dir / "world" / "run" / "dist").mkdir(parents=True)
        procs = iter([play, recorder])
        with mock.patch.object(film.subprocess, "Popen", lambda *a, **k: next(procs)), \
                mock.patch.object(film.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0)), \
                mock.patch.object(film, "_free_port", lambda: 1234), \
                mock.patch.object(film, "_lines", lambda proc: object()), \
                mock.patch.object(film, "_next", lambda q, pred, timeout: "http://127.0.0.1/"), \
                mock.patch.object(film, "page_url", lambda *a: "http://127.0.0.1/"):
            t = time.monotonic()
            with self.assertRaises(RuntimeError) as cm:
                film.record_scene(run_dir, Path(d.name) / "film.mp4", max_s=600)
        return str(cm.exception), time.monotonic() - t

    def test_dead_play_stops_the_recorder_with_its_exit_code(self):
        rec = Recorder()
        msg, took = self._record(Play(7), rec)
        self.assertIn("make.play exit 7", msg)
        self.assertTrue(rec.killed, "the recorder must not be left waiting for the page")
        self.assertLess(took, 30)

    def test_live_play_keeps_the_recorder_failure(self):
        msg, _ = self._record(Play(None), Recorder(1))
        self.assertIn("record.mjs exit 1", msg)


if __name__ == "__main__":
    unittest.main()
