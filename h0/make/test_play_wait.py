"""make.play --wait-viewer: the sim starts when the page connects (or after a timeout); --fake never waits."""
import http.client
import io
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from . import play
from .test_play import _run_dir

DREAM = Path(__file__).resolve().parents[1] / "dream"
sys.path.insert(0, str(DREAM))
import server  # noqa: E402


class _StubSim:
    stopped = False

    def status(self):
        return {"type": "status"}


def _viewer():
    tmp = tempfile.TemporaryDirectory()
    try:
        root = tmp.name
        os.makedirs(os.path.join(root, "prof", "r1"))
        with open(os.path.join(root, "prof", "r1", "log.jsonl"), "w") as f:
            f.write('{"seq": 0, "type": "x"}\n')
        v = server.Viewer(sim=_StubSim(), run="prof/r1", root=root)
        v.start(0)
    except BaseException:
        tmp.cleanup()
        raise
    v.sim.viewer = v
    _stop = v.stop
    state = {"done": False}

    def _stop_and_cleanup():
        try:
            _stop()
        finally:
            if not state["done"]:
                state["done"] = True
                tmp.cleanup()

    v.stop = _stop_and_cleanup
    return v


def _mk_run_dir(test, brief):
    d = _run_dir(brief)
    test.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
    return d


class ViewerWait(unittest.TestCase):
    def test_waits_for_client_then_first_event(self):
        v = _viewer()
        self.addCleanup(v.stop)
        got = {}

        def client():
            time.sleep(2)
            c = http.client.HTTPConnection("127.0.0.1", v.port, timeout=10)
            c.request("GET", "/events?run=prof/r1", headers={"Host": "127.0.0.1:%d" % v.port})
            r = c.getresponse()
            got["t"] = time.monotonic()
            got["line"] = r.fp.readline()
            r.close()
            c.close()
        th = threading.Thread(target=client)
        t0 = time.monotonic()
        th.start()
        self.assertFalse(v.client_connected.is_set())
        self.assertTrue(v.wait_client(15))
        self.assertGreaterEqual(time.monotonic() - t0, 1.9)
        th.join(10)
        self.assertGreaterEqual(got["t"], t0 + 1.9)
        self.assertTrue(got["line"])

    def test_wait_client_times_out(self):
        v = _viewer()
        self.addCleanup(v.stop)
        self.assertFalse(v.wait_client(0.1))


class PlayWait(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def _run(self, **kw):
        seen = {}

        def run(**k):
            seen.update(k)
            if k.get("on_sim"):
                seen["sim"] = _StubSim()
                seen["sim"].viewer = kw.pop("_viewer", None) or seen.get("viewer")
                k["on_sim"](seen["sim"])
            return None, None
        return run, seen

    def test_timeout_starts_with_warning(self):
        d = _mk_run_dir(self, {"mode": "seed", "book": None})
        v = _viewer()
        self.addCleanup(v.stop)
        seen = {}

        def run(**k):
            seen["on_sim"] = k.get("on_sim")
            s = _StubSim()
            s.viewer = v
            if k.get("on_sim"):
                k["on_sim"](s)
            return None, None
        buf = io.StringIO()
        with redirect_stdout(buf), mock.patch.object(play, "_fake_touch_reply", return_value="x"), \
                mock.patch("sim.seed_start", return_value=(None, [])), \
                mock.patch("voice.load_pool", return_value={}):
            play.play(d, fake=False, serve=0, run=run, wait_viewer=True, wait_timeout=0.2)
        self.assertIsNotNone(seen["on_sim"])
        self.assertIn("WARN no viewer after 0.2s, starting anyway", buf.getvalue())

    def test_connected_viewer_no_warning(self):
        d = _mk_run_dir(self, {"mode": "seed", "book": None})
        v = _viewer()
        self.addCleanup(v.stop)
        v.client_connected.set()

        def run(**k):
            s = _StubSim()
            s.viewer = v
            k["on_sim"](s)
            return None, None
        buf = io.StringIO()
        with redirect_stdout(buf), mock.patch("sim.seed_start", return_value=(None, [])), \
                mock.patch("voice.load_pool", return_value={}):
            play.play(d, fake=False, serve=0, run=run, wait_viewer=True, wait_timeout=5)
        self.assertNotIn("WARN", buf.getvalue())

    def test_fake_never_waits(self):
        d = _mk_run_dir(self, {"mode": "seed", "book": None})
        seen = {}

        def run(**k):
            seen.update(k)
            return None, None
        play.play(d, fake=True, run=run, wait_viewer=True, wait_timeout=0.1)
        self.assertFalse(seen.get("on_sim"))


class MainWait(unittest.TestCase):
    def _main(self, argv):
        calls = {}
        hold = mock.Mock()
        srv = mock.Mock()
        with mock.patch.object(play, "play", side_effect=lambda *a, **k: calls.update(k) or (None, "log")), \
                mock.patch.object(play, "serve_static", return_value=(srv, 1234)), \
                redirect_stdout(io.StringIO()):
            play.main(argv, hold=hold)
        return calls, hold, srv

    def test_live_waits_by_default_and_holds(self):
        calls, hold, srv = self._main(["runs/x"])
        self.assertTrue(calls["wait_viewer"])
        hold.assert_called_once()
        srv.shutdown.assert_called_once()

    def test_no_wait_viewer(self):
        calls, hold, _ = self._main(["runs/x", "--no-wait-viewer"])
        self.assertFalse(calls["wait_viewer"])
        hold.assert_not_called()

    def test_fake_does_not_wait(self):
        calls, hold, _ = self._main(["runs/x", "--fake"])
        self.assertFalse(calls["wait_viewer"])
        hold.assert_not_called()


if __name__ == "__main__":
    unittest.main()
