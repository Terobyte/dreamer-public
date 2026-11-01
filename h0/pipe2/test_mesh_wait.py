"""Mesh reserves wait for a running mesh instead of hitting the cap (bathroom cap_hit bug).

Offline: fake providers, real Ledger in a temp dir, no network."""

import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

from pipe2.assets import AssetQueue
from pipe2.ledger import Ledger

PRICES = {"image": 0.0, "h100_s": 1.0}
TIMEOUT_S = 10  # one mesh reserve = $10


def _no_net(*_a, **_k):
    raise AssertionError("network is forbidden in tests")


class Images:
    def generate(self, prompt, size):
        return b"png"


class Handle:
    def __init__(self, owner):
        self.owner = owner

    def get(self, timeout):
        # Keep the first three meshes in flight until all three are submitted,
        # so the run provably overlaps instead of serializing. Smaller runs
        # (total < 3) proceed immediately.
        owner = self.owner
        deadline = time.time() + 90
        want = min(3, owner.total)
        while len(owner.names) < want and time.time() < deadline:
            time.sleep(0.005)
        if len(owner.names) < want:
            raise TimeoutError("mesh gate timed out")
        # a short window where all three are provably running at once
        time.sleep(0.05)
        with owner.lock:
            owner.running -= 1
        return {"glb": b"glb", "sec": 1.0}


class Meshes:
    def __init__(self, ledger, total):
        self.ledger = ledger
        self.total = total
        self.lock = threading.Lock()
        self.running = 0
        self.max_running = 0
        self.names = []
        self.at_three_running = None

    def submit(self, name, png):
        with self.lock:
            self.names.append(name)
            self.running += 1
            self.max_running = max(self.max_running, self.running)
            if len(self.names) == 3:
                self.at_three_running = self.running
        return Handle(self)


def _build(cap_usd, count):
    tmp = Path(tempfile.mkdtemp())
    ledger = Ledger(tmp / "events.jsonl", PRICES, cap_usd, 100)
    events = []
    real_record = ledger.record

    def record(event):
        events.append(event)
        real_record(event)

    ledger.record = record
    # peak over every successful reserve grant, not just at submit time
    peak = [0.0]
    real_reserve = ledger.reserve

    def reserve(kind, estimate_usd, reserve_tokens=0):
        ok = real_reserve(kind, estimate_usd, reserve_tokens)
        if ok:
            with ledger._lock:
                peak[0] = max(peak[0], ledger.usd_reserved)
        return ok

    ledger.reserve = reserve
    meshes = Meshes(ledger, count)
    queue = AssetQueue(tmp / "cache", Images(), meshes, ledger, mesh_timeout_s=TIMEOUT_S,
                       poll_s=0.01, sleep=lambda s: None)
    keys = [{"key": f"obj{i}", "kind": "object", "prompt": "a thing", "size": "1024x1024"}
            for i in range(count)]
    queue.put("bath", keys)
    deadline = time.time() + 90
    while not queue.done("bath") and time.time() < deadline:
        time.sleep(0.01)
    queue.close()
    return tmp / "cache", ledger, meshes, events, peak[0]


class TestMeshReserveWaits(unittest.TestCase):
    def setUp(self):
        self._urlopen = urllib.request.urlopen
        urllib.request.urlopen = _no_net

    def tearDown(self):
        urllib.request.urlopen = self._urlopen

    def test_six_meshes_three_reserves_fit_all_arrive(self):
        cache, ledger, meshes, events, peak = _build(cap_usd=35.0, count=6)
        failed = [e for e in events if e.get("kind") == "asset_failed"]
        self.assertEqual(failed, [])
        self.assertFalse([e for e in events if e.get("kind") == "cap_hit"])
        # waiting meshes settle instead of capping: no WARN while a mesh is running
        self.assertFalse([e for e in events if e.get("kind") == "WARN"])
        self.assertEqual(sorted(meshes.names), [f"obj{i}" for i in range(6)])
        for i in range(6):
            self.assertTrue((cache / f"obj{i}.glb").exists())
        # three at a time, not serialized: the first three overlap
        self.assertEqual(meshes.at_three_running, 3)
        self.assertEqual(meshes.max_running, 3)
        # no reserve grant ever pushes the booked sum over the budget
        self.assertLessEqual(peak, 35.0)
        self.assertLessEqual(ledger.spent, 35.0)
        self.assertFalse(ledger.capped)

    def test_reserve_bigger_than_budget_is_cap_with_warn(self):
        cache, ledger, meshes, events, _peak = _build(cap_usd=5.0, count=1)
        self.assertEqual(meshes.names, [])
        failed = [e for e in events if e.get("kind") == "asset_failed"]
        self.assertEqual([(e["asset"], e["reason"]) for e in failed], [("obj0", "cap")])
        warns = [e for e in events if e.get("kind") == "WARN"]
        self.assertTrue(warns)
        self.assertEqual(warns[0]["asset"], "obj0")
        self.assertEqual(warns[0].get("reason"), "cap")
        self.assertFalse((cache / "obj0.glb").exists())
        # a reserve that never fits waits for nothing: WARN, not a run-wide cap_hit
        self.assertFalse([e for e in events if e.get("kind") == "cap_hit"])
        self.assertFalse(ledger.capped)


class TestLedgerReserve(unittest.TestCase):
    def test_reserve_refusal_does_not_cap_the_run(self):
        ledger = Ledger(Path(tempfile.mkdtemp()) / "e.jsonl", PRICES, 15.0, 100)
        self.assertTrue(ledger.reserve("h100_s", 10.0))
        self.assertFalse(ledger.reserve("h100_s", 10.0))
        self.assertFalse(ledger.capped)
        ledger.charge("h100_s", 1.0, reserved=10.0)
        self.assertTrue(ledger.reserve("h100_s", 10.0))


if __name__ == "__main__":
    unittest.main()
