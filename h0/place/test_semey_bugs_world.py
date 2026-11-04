"""Hunt 2026-11-04 red tests for semey world: B11 B12 B13 B14 B15. No network.

Each test asserts the documented expected behaviour, so it FAILS on the current code at its own assertion.

  cd h0 && python3 -m unittest place.test_semey_bugs_world -v
"""
import contextlib
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from place import semey as S
from pipe2.ledger import Ledger

TOK = lambda i: f"{i:032x}"


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FakeProg:
    def __init__(self, *a, **k):
        self.took = {}
        self.path = Path(a[0])
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def start(self, *a):
        pass

    def emit(self, *a):
        pass

    def finish(self, ok, note=""):
        with self.path.open("a") as f:
            f.write(json.dumps({"t": 1, "pct": 100, "stage": "done" if ok else "failed"}) + "\n")


class GatedScaler:
    """autoscaler fake: a call with `gate_on` blocks until the test sets `gate` (bounded wait, never hangs)"""

    def __init__(self, gate_on=lambda a: True, raise_on=lambda a: False):
        self.gate = threading.Event()
        self.entered = threading.Event()
        self.gate_on, self.raise_on = gate_on, raise_on
        self.calls = []

    def set(self, *a):
        self.calls.append(a)
        if self.raise_on(a):
            raise RuntimeError("modal unavailable")
        if getattr(self, "fail_off_once", False) and a[0] == 0:
            self.fail_off_once = False
            raise RuntimeError("modal unavailable")
        if self.gate_on(a):
            self.entered.set()
            self.gate.wait(10)


class BugsWorld(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "f.json").write_text("{}")
        self.clock = Clock()
        self.threads = []

    def tearDown(self):
        # release any gated RPC so no daemon thread outlives its test
        for ev in getattr(self, "gates", []):
            ev.set()

    def world(self, warm=None, builder=None, start_threads=True):
        def ok_builder(job, prog, spark_lock, slots_sem):
            part = Path(job["data"]) / "parts" / job["wid"]
            part.mkdir(parents=True, exist_ok=True)
            (part / "box.json").write_text(json.dumps({"label": "Аптека"}))
        w = S.World(self.tmp, self.tmp / "f.json", builder=builder or ok_builder, warm=warm, clock=self.clock,
                    progress_cls=FakeProg, start_threads=start_threads)
        w.st["claims"] = True
        return w

    # ---- B11: Warm.lock / World.lock order inversion ----
    def test_B11_warm_off_and_admin_free_do_not_deadlock(self):
        """expected: no lock cycle; actual: Warm.remove holds Warm.lock and waits for World.lock in
        on_spend while admin(free) holds World.lock and waits for Warm.lock -> permanent hang"""
        sc = GatedScaler(gate_on=lambda a: a[0] == 0)
        self.gates = [sc.gate]
        warm = S.Warm(sc, clock=self.clock)
        w = self.world(warm=warm, start_threads=False)
        warm.add("wX")                       # warm on, until = {wX}
        w.st["places"]["2"] = {"state": "building", "wid": "wY", "started": False, "t_claim": self.clock(),
                               "nick": "a", "label": "x"}
        a = threading.Thread(target=warm.remove, args=("wX",), daemon=True)
        a.start()
        self.assertTrue(sc.entered.wait(3), "setup: warm off never reached the autoscaler")
        b = threading.Thread(target=w.admin, args=("free", 2), daemon=True)
        b.start()
        time.sleep(0.3)                      # admin(free) now holds World.lock, waits on Warm.lock
        sc.gate.set()                        # warm off returns, wants World.lock for on_spend
        a.join(3)
        b.join(3)
        self.assertFalse(b.is_alive() or a.is_alive(),
                         "deadlock: admin(free) and warm off wait on each other's lock (expected: finish, actual: hang)")

    # ---- B12: Modal RPC inside Warm.lock ----
    def test_B12_autoscaler_rpc_does_not_hold_warm_lock(self):
        """expected: claim/view never wait on a network call; actual: count() queues behind autoscaler.set"""
        sc = GatedScaler(gate_on=lambda a: a[0] == 1)
        self.gates = [sc.gate]
        warm = S.Warm(sc, {}, clock=self.clock)
        a = threading.Thread(target=warm.add, args=("w1",), daemon=True)
        a.start()
        self.assertTrue(sc.entered.wait(3), "setup: add never reached the autoscaler")
        probe = threading.Thread(target=warm.count, daemon=True)
        probe.start()
        probe.join(1.0)
        still_waiting = probe.is_alive()
        sc.gate.set()
        a.join(3)
        probe.join(3)
        self.assertFalse(still_waiting,
                         "count() waited >1 s behind the autoscaler RPC (expected: returns at once, actual: blocked)")

    # ---- B13: failed warm-off never retried ----
    def test_B13_failed_warm_off_is_retried_by_tick(self):
        """expected: off retried by tick until it succeeds; actual: on_since cleared before the RPC, so one
        failed set(0) leaves the GPU warm forever"""
        sc = GatedScaler()
        sc.fail_off_once = True
        warm = S.Warm(sc, clock=self.clock)
        with contextlib.redirect_stdout(io.StringIO()):
            warm.add("w1")
            warm.remove("w1")                # set(0) raises once
            warm.tick()                      # tick must retry the off
        offs = [c for c in sc.calls if c[0] == 0]
        self.assertGreaterEqual(len(offs), 2,
                                f"warm off not retried after a failure: off calls = {len(offs)} (expected >=2)")

    # ---- B14: asset_cost double counts cap_hit ----
    def test_B14_asset_cost_ignores_cap_hit_cumulative_row(self):
        """expected: a build capped at ~$2 books $2; actual: the ledger's cap_hit row (cost_usd=self.spent, a
        running total) is summed on top of the real charge, so it books ~$4"""
        part = self.tmp / "parts" / "wcap"
        part.mkdir(parents=True)
        led = Ledger(part / "events.jsonl", {"image": 1.0}, cap_usd=3.0, cap_calls=10, clock=self.clock)
        led.charge("image", 2)               # real spend: $2.00
        granted = led.allow("image", 1.5)    # 2.0 + 1.5 > 3.0 -> refused, writes cap_hit row
        self.assertFalse(granted, "setup: the second image should be refused by the cap")
        led.close()
        self.assertEqual(S.asset_cost(part), 2.0,
                         f"asset_cost = {S.asset_cost(part)}, real spend = 2.0 (cap_hit row double counted)")

    # ---- B15: over_budget checked only on warm spend ----
    def test_B15_run_job_spend_over_budget_turns_claims_off(self):
        """expected (spec): spent_usd > 20 -> claims false + over_budget line; actual: run_job's finally adds the
        asset cost straight to spent_usd, so claims stay true at $21"""
        go = threading.Event()

        def costly_builder(job, prog, spark_lock, slots_sem):
            part = Path(job["data"]) / "parts" / job["wid"]
            part.mkdir(parents=True, exist_ok=True)
            go.wait(5)                       # the test lowers the budget headroom first
            (part / "events.jsonl").write_text(json.dumps({"cost_usd": 2.0}) + "\n")
            (part / "box.json").write_text(json.dumps({"label": "Аптека"}))
        w = self.world(builder=costly_builder)
        wid = w.claim(2, "a", "аптека", TOK(1))
        w.st["spent_usd"] = 18.5             # money already spent elsewhere; claim checks passed earlier
        go.set()
        th = w.running.get(wid)
        if th:
            th.join(5)
        self.assertEqual(w.st["places"]["2"]["state"], "built", "setup: build should have finished")
        self.assertAlmostEqual(w.st["spent_usd"], 20.5, places=2)
        self.assertFalse(w.st["claims"],
                         f"claims still on at spent_usd={w.st['spent_usd']} > {S.BUDGET_USD} (expected: off)")
        self.assertIn("over_budget", (self.tmp / "failures.jsonl").read_text())


if __name__ == "__main__":
    unittest.main()
