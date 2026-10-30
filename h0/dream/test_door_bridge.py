"""Door bridge <-> sandbox server: the engine's contractual touch payload and
the engine origin on another loopback port (phase G2 blockers F1, F7).
usage: cd h0/dream && python3 -m unittest test_door_bridge -q
"""

import http.client
import json
import os
import shutil
import tempfile
import unittest

from server import Viewer


class _FakeSim:
    def __init__(self):
        self.got = []
        self.stopped = False

    def submit(self, kind, payload=None):
        self.got.append((kind, payload))
        if kind == "stop":
            self.stopped = True

    def status(self):
        return {"type": "snapshot", "live": True, "build_state": "building"}


class DoorBridgeTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.run_dir = os.path.join(self.root, "A", "run_1")
        os.makedirs(self.run_dir)
        with open(os.path.join(self.run_dir, "log.jsonl"), "w") as f:
            f.write(json.dumps({"seq": 1, "t": 0.1, "type": "line", "text": "hi"}) + "\n")
        self.sim = _FakeSim()
        self.viewer = Viewer(sim=self.sim, run="A/run_1", root=self.root, snapshot_every=0.3)
        self.port = self.viewer.start(0)

    def tearDown(self):
        self.viewer.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def _req(self, method, path, body=None, headers=None, host=None, read=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": host or "127.0.0.1:%d" % self.port}
        h.update(headers or {})
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        # an SSE stream never ends: read headers only, never the body
        data = resp.read() if read else None
        conn.close()
        return resp, data

    def _post(self, path, obj, **kw):
        return self._req("POST", path, json.dumps(obj).encode(),
                         dict({"Content-Type": "application/json"}, **kw.pop("headers", {})), **kw)

    def test_contract_touch_reaches_sim(self):
        # the exact payload the engine bridge posts on door_touch (phase G2)
        resp, _ = self._post("/event", {"type": "touch", "object": "front"})
        self.assertEqual(resp.status, 200)
        kinds = [k for k, _ in self.sim.got]
        self.assertIn("event", kinds)
        _, ev = self.sim.got[-1]
        self.assertEqual(ev.get("value"), "front")

    def test_engine_origin_sse_and_preflight(self):
        # the engine page runs on another loopback port (?sim=http://127.0.0.1:8770)
        origin = "http://127.0.0.1:4173"
        resp, _ = self._req("GET", "/events?run=A/run_1",
                            headers={"Origin": origin, "Accept": "text/event-stream"},
                            read=False)
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Access-Control-Allow-Origin"), origin)
        resp, _ = self._req("OPTIONS", "/event", headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        self.assertEqual(resp.status, 204)
        self.assertEqual(resp.getheader("Access-Control-Allow-Origin"), origin)
        resp, _ = self._post("/event", {"type": "touch", "object": "front"},
                              headers={"Origin": origin})
        self.assertEqual(resp.status, 200)

    def test_foreign_origin_still_forbidden(self):
        resp, _ = self._post("/say", {"text": "hi"}, headers={"Origin": "http://evil.com"})
        self.assertEqual(resp.status, 403)
        self.assertEqual(self.sim.got, [])


if __name__ == "__main__":
    unittest.main()
