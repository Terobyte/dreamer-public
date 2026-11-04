"""Hunt 2026-11-04 (c) bugs B41, B42, B43, B49 as red tests. Localhost only, no network, no sleeps-and-hope.

Each test is expected to FAIL on the current code at its own assertion (see bugs.md, "Hunt 2026-11-04 (c)").

  cd h0 && python3 -m unittest place.test_semey_bugs_c -v
"""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from place import semey as S
from place import semey_admin as A
from place.test_semey import ADMIN, KEY, TOK, Clock

BARE = "highskilltero--semey-web.modal.run"
REGION = "highskilltero--semey-web.us-east.modal.run"


class FakeJobProg:
    def __init__(self):
        self.took, self.label = {}, ""

    def start(self, *a):
        pass

    def emit(self, *a):
        pass


class Base(unittest.TestCase):
    autoscaler = None

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.features = self.tmp / "features.json"
        self.features.write_text(json.dumps({"season": "autumn", "house": {"wall_tile": "brick"}}))
        self.client = self.tmp / "client"
        self.client.mkdir()
        (self.client / "index.html").write_text("<html>semey</html>")
        self.clock = Clock()
        warm = S.Warm(autoscaler=self.autoscaler, clock=self.clock) if self.autoscaler else None
        self.w = S.World(self.tmp, self.features, builder=lambda *a: None, clock=self.clock, warm=warm,
                         progress_cls=lambda *a, **k: FakeJobProg(), start_threads=False)

    def serve(self, public_host):
        h = S.make_handler(self.w, self.client, public_host, KEY, ADMIN, asr=lambda b: "")
        srv = S.BoundedServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        return srv.server_address[1]

    def req(self, port, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            r = conn.getresponse()
            return r.status, dict(r.getheaders()), r.read()
        finally:
            conn.close()


class B41_RegionHost(Base):
    def test_B41_comma_list_public_host_accepts_region_host(self):
        port = self.serve(f"{BARE},{REGION}")
        st, _, body = self.req(port, "GET", "/api/slots", {"Host": REGION})
        self.assertEqual(st, 200, f"GET /api/slots with Host {REGION} -> {st} {body!r}")

    def test_B41_bare_host_still_works(self):
        port = self.serve(f"{BARE},{REGION}")
        st, _, body = self.req(port, "GET", "/api/slots", {"Host": BARE})
        self.assertEqual(st, 200, f"bare host -> {st} {body!r}")

    def test_B41_post_from_region_origin_not_refused_on_host_or_origin(self):
        port = self.serve(f"{BARE},{REGION}")
        st, _, body = self.req(port, "POST", "/api/claim",
                               {"Host": REGION, "Origin": f"https://{REGION}", "Content-Type": "application/json"},
                               json.dumps({"place": 2}).encode())
        err = json.loads(body or b"{}").get("error")
        self.assertFalse(st == 403 and err in ("host", "origin"), f"POST from region origin refused: {st} {err!r}")


class B42_RpcUnderWorldLock(Base):
    def setUp(self):
        self.entered, self.release = threading.Event(), threading.Event()
        self.block = False
        outer = self

        class Blocking:
            def __bool__(self):
                return True

            def set(self, *a):
                if outer.block:
                    outer.entered.set()
                    outer.release.wait(10)

        self.autoscaler = Blocking()
        super().setUp()

    def test_B42_world_lock_free_while_autoscaler_set_blocks(self):
        self.w.admin("claims", on=True)
        wid = self.w.claim(2, "nick", "a small wish for a pharmacy", TOK(1))
        self.w.warm.add(wid)                 # last warm hold; autoscaler "on" returns at once
        self.block = True
        t = threading.Thread(target=self.w.admin, args=("free", 2), daemon=True)   # -> _release_locked -> warm.remove -> set(0..)
        t.start()
        try:
            self.assertTrue(self.entered.wait(5), "the autoscaler set() was never reached by admin free")
            got = self.w.lock.acquire(timeout=1)
            if got:
                self.w.lock.release()
            self.assertTrue(got, "World.lock is held while the autoscaler RPC is in flight")
        finally:
            self.release.set()
            t.join(5)


class B43_AdminInput(Base):
    def test_B43_float_place_is_400_place(self):
        port = self.serve("semey.example")
        try:
            st, _, body = self.req(port, "POST", "/api/admin",
                                   {"Host": f"localhost:{port}", "X-Admin-Key": ADMIN, "Content-Type": "application/json"},
                                   json.dumps({"op": "free", "place": 2.0}).encode())
        except (http.client.HTTPException, OSError) as e:
            self.fail(f"no reply for place 2.0 (dropped connection): {e!r}")
        self.assertEqual(st, 400, f"place 2.0 -> {st} {body!r}")
        self.assertEqual(json.loads(body).get("error"), "place")

    def test_B43_cli_free_abc_exits_cleanly(self):
        with mock.patch.object(A, "call", return_value=(200, {})):
            try:
                A.main(["http://x", "free", "abc"])
            except SystemExit:
                return
            except ValueError as e:
                self.fail(f"main crashed with a raw ValueError instead of a usage exit: {e!r}")
            self.fail("main returned instead of exiting with usage")

    def test_B43_call_without_key_is_clean_exit(self):
        import keys
        with mock.patch.dict("os.environ", {}, clear=False) as env:
            env.pop("ADMIN_KEY", None)
            with mock.patch.object(keys, "_from_file", return_value=None), \
                    mock.patch.object(A.urllib.request, "urlopen", side_effect=AssertionError("no request without a key")):
                with self.assertRaises(SystemExit):
                    A.call("http://x", {"op": "status"})


class B49_Range(Base):
    def test_B49_range_request_gets_206(self):
        data = bytes(range(100))
        (self.client / "video.mp4").write_bytes(data)
        port = self.serve("semey.example")
        h = {"Host": f"localhost:{port}"}
        st, hd, _ = self.req(port, "GET", "/video.mp4", h)
        self.assertEqual({k.lower(): v for k, v in hd.items()}.get("accept-ranges"), "bytes", f"plain GET headers: {hd!r}")
        st, hd, body = self.req(port, "GET", "/video.mp4", {**h, "Range": "bytes=0-9"})
        self.assertEqual(st, 206, f"Range request -> {st}")
        self.assertEqual({k.lower(): v for k, v in hd.items()}.get("content-range"), "bytes 0-9/100")
        self.assertEqual(body, data[:10])


if __name__ == "__main__":
    unittest.main()
