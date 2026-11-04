"""Hunt 2026-11-04 (b) bugs B30-B36 and B40 in semey.py / semey_modal.py / semey_admin.py, as red tests. Localhost only.

Each test is expected to FAIL on the current code at its own assertion (see bugs.md, "Hunt 2026-11-04 (b)").
A test that passes on the current code means the bug is already fixed there; it is reported as such.

  cd h0 && python3 -m unittest place.test_semey_bugs_more -v
"""
import contextlib
import http.client
import http.server
import io
import json
import os
import select
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from place import semey as S
from place import semey_admin as A
from place import semey_modal as M
from place.test_semey import ADMIN, KEY, TOK, Clock

WID = "w" + "b" * 12


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.features = self.tmp / "features.json"
        self.features.write_text(json.dumps({"season": "autumn", "house": {"wall_tile": "brick"}}))
        self.clock = Clock()


class FakeAutoscaler:
    def __init__(self):
        self.calls = []

    def __bool__(self):
        return True

    def set(self, *a):
        self.calls.append(a)


class FakeJobProg:
    """the Progress surface build_place uses"""
    def __init__(self):
        self.took, self.label = {}, ""

    def start(self, *a):
        pass

    def emit(self, *a):
        pass


class HttpServed(Base):
    """a real BoundedServer on 127.0.0.1 port 0, the same way test_semey_bugs_http starts it"""
    def setUp(self):
        super().setUp()
        self.client = self.tmp / "client"
        self.client.mkdir()
        (self.client / "index.html").write_text("<html>semey</html>")
        self.w = S.World(self.tmp, self.features, builder=lambda *a: None, clock=self.clock,
                         progress_cls=lambda *a, **k: FakeJobProg(), start_threads=False)
        h = S.make_handler(self.w, self.client, "semey.example", KEY, ADMIN, asr=lambda b: "")
        self.srv = S.BoundedServer(("127.0.0.1", 0), h)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()


class B30_JudgeKeyInStdout(Base):
    def test_B30_main_does_not_print_judge_key(self):
        data = self.tmp / "data"
        client = self.tmp / "client"
        client.mkdir()
        (client / "index.html").write_text("<html>semey</html>")
        argv = ["semey", "--data", str(data), "--client", str(client), "--features", str(self.features), "--port", "0"]
        out = io.StringIO()
        import keys
        with mock.patch("sys.argv", argv), mock.patch.dict(os.environ, {"JUDGE_KEY": KEY, "ADMIN_KEY": ADMIN}), \
                mock.patch.object(keys, "get", lambda *a, **k: "x"), \
                mock.patch.object(S, "World"), mock.patch.object(S, "BoundedServer"), \
                mock.patch.object(S, "_ticker"), contextlib.redirect_stdout(out):
            S.main()
        printed = out.getvalue()
        self.assertTrue(printed.strip(), "main printed nothing; the test did not reach the startup line")
        self.assertNotIn(KEY, printed, f"judge key printed to stdout: {printed.strip()!r}")


class B31_SlowDrip(HttpServed):
    def test_B31_slow_drip_request_is_closed_within_25s(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        # the request line and Host header, then header-value bytes that never end the header block
        stream = b"GET / HTTP/1.1\r\nHost: localhost\r\n" + b"a" * 100
        closed = False
        try:
            start = time.monotonic()
            i = 0
            while time.monotonic() - start < 25:
                try:
                    s.sendall(stream[i:i + 1])
                except OSError:
                    closed = True
                    break
                i += 1
                # wait up to 2 s for the server to close (recv b"" = closed); one byte per 2 s is the drip
                r, _, _ = select.select([s], [], [], 2.0)
                if r:
                    try:
                        if s.recv(4096) == b"":
                            closed = True
                            break
                    except OSError:
                        closed = True
                        break
            elapsed = time.monotonic() - start
        finally:
            s.close()
        self.assertTrue(closed, f"server still holds a slow-drip request after {elapsed:.1f} s (no whole-request deadline)")


class B32_SuperviseRestarts(unittest.TestCase):
    def test_B32_modal_launcher_restarts_exited_server(self):
        self.assertTrue(hasattr(M, "supervise"),
                        "semey_modal has no restartable launcher: web() is a bare Popen, a crash leaves the world dead")
        launched = []

        class ExitsNow:
            def wait(self, *a, **k):
                return 1

            def poll(self):
                return 1

        def fake_popen(cmd, cwd=None, env=None, **k):
            launched.append(cmd)
            return ExitsNow()

        sleeps = []

        def fake_sleep(s):
            sleeps.append(s)
            if len(sleeps) >= 3:
                raise StopIteration

        try:
            M.supervise(["python", "-m", "place.semey"], "/root/h0", {}, popen=fake_popen, sleep=fake_sleep)
        except StopIteration:
            pass
        self.assertGreaterEqual(len(launched), 2, f"exited server not restarted: popen called {len(launched)} time(s)")


class B33_RateNeverPrunes(Base):
    def test_B33_rate_forgets_idle_keys(self):
        clock = Clock()
        rate = S.Rate(clock=clock)
        for i in range(5000):
            self.assertTrue(rate.ok(("claim", f"10.0.{i // 256}.{i % 256}"), 3))
        clock.t += 3600                      # every window is long past
        self.assertTrue(rate.ok(("claim", "10.9.9.9"), 3))
        self.assertLess(len(rate.hits), 100, f"Rate keeps {len(rate.hits)} keys after their windows expired")


class B34_RestartSwitchesWarmOff(Base):
    def test_B34_restart_over_started_build_switches_autoscaler_off(self):
        slots = {"version": 1, "claims": True, "launches": 1, "spent_usd": 0.0, "reserves": {WID: 0.5}, "asr_count": 0,
                 "asr_tokens": {}, "tokens": [],
                 "places": {"1": {"state": "free"}, "2": {"state": "building", "wid": WID, "started": True,
                                                         "t_claim": self.clock.t - 60, "nick": "a"},
                            "3": {"state": "free"}, "4": {"state": "free"}, "5": {"state": "free"}}}
        (self.tmp / "slots.json").write_text(json.dumps(slots))
        auto = FakeAutoscaler()
        warm = S.Warm(autoscaler=auto, clock=self.clock)
        w = S.World(self.tmp, self.features, builder=lambda *a: None, warm=warm, clock=self.clock,
                    progress_cls=lambda *a, **k: FakeJobProg(), start_threads=False)
        w.watch()
        off_calls = [c for c in auto.calls if c and c[0] == 0]
        self.assertTrue(off_calls, f"autoscaler never told off after restart; calls={auto.calls}")


class B35_MissingObjectsStillBuilt(Base):
    def test_B35_build_fails_when_every_3d_object_is_missing(self):
        from place import assets, shop
        job = {"wid": WID, "text": "аптека", "nick": "a", "place": S.PLACES[2], "data": self.tmp,
               "features": self.features}
        scene = {"objects": [{"id": "shelf"}, {"id": "counter"}]}
        box = {"room": {"x0": -3, "x1": 3, "z0": -5, "z1": 0}}
        spec = {"label": "Аптека", "sign": "аптека"}
        all_missing = {"keys": 5, "missing": ["shelf", "counter"]}
        with mock.patch.object(S, "wish_spec_place", lambda *a, **k: spec), \
                mock.patch.object(shop, "shop_scene", lambda *a, **k: (scene, box)), \
                mock.patch.object(assets, "fill_cache", lambda *a, **k: all_missing), \
                mock.patch.object(assets, "build_dist", lambda *a, **k: 0), \
                mock.patch.object(assets, "fit_props", lambda *a, **k: 0):
            with self.assertRaises(RuntimeError, msg="every 3D object missing, yet the place was built as an empty shell"):
                S.build_place(job, FakeJobProg(), threading.Lock(), threading.BoundedSemaphore(2))


class _Html502(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = b"<html><body>502 Bad Gateway</body></html>"
        self.send_response(502)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class B36_AdminCrashes(unittest.TestCase):
    def test_B36_free_without_place_number_exits_cleanly(self):
        url = "http://127.0.0.1:9"       # never contacted: the missing N is rejected before any request
        with mock.patch.dict(os.environ, {"ADMIN_KEY": ADMIN}):
            try:
                rc = A.main([url, "free"])
            except SystemExit:
                rc = "exit"
            except Exception as e:
                self.fail(f"free without N raised {type(e).__name__} instead of a usage exit")
        self.assertTrue(rc == "exit" or rc != 0, f"free without N returned {rc!r}, expected usage exit or non-zero")

    def test_B36_non_json_error_body_does_not_crash_call(self):
        srv = http.server.HTTPServer(("127.0.0.1", 0), _Html502)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{srv.server_address[1]}"
            with mock.patch.dict(os.environ, {"ADMIN_KEY": ADMIN}):
                try:
                    got = A.call(url, {"op": "status"})
                except Exception as e:
                    self.fail(f"call() raised {type(e).__name__} on a 502 text/html body")
            self.assertEqual(got[0], 502, f"expected (502, ...), got {got!r}")
        finally:
            srv.shutdown()
            srv.server_close()


class B40_CallerIpReported(HttpServed):
    def test_B40_status_reports_caller_ip_as_server_sees_it(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("POST", "/api/admin", body=json.dumps({"op": "status"}).encode(),
                         headers={"Host": f"localhost:{self.port}", "X-Admin-Key": ADMIN,
                                  "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4"})
            resp = conn.getresponse()
            body = json.loads(resp.read())
        finally:
            conn.close()
        self.assertEqual(resp.status, 200, f"admin status failed: {body!r}")
        self.assertIn("you", body, "admin status has no 'you' key with the caller ip")
        self.assertEqual(body["you"], "127.0.0.1", "caller ip must be the socket peer, not the X-Forwarded-For value")


if __name__ == "__main__":
    unittest.main()
