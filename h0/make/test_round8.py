"""F2/F3/F10/F17/F18: входы предков, атомарная публикация, гонка stale-лока, бюджет."""
import dataclasses
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from make import core


def _stages(**over):
    out = {}
    for sid, st in core.default_stages().items():
        out[sid] = dataclasses.replace(st, fn=over.get(sid, st.fn))
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(core, "STUB_SLEEP", 0.05))
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.run_dir = Path(t.name) / "run"


class TestMissingMarker(Base):
    def test_only_stage_without_world_marker(self):
        core.run_make(self.run_dir, prompt="p")
        (self.run_dir / "world" / "marker.txt").unlink()
        calls = []
        st = _stages(stage=lambda ctx: calls.append(1))
        with self.assertRaises(core.MissingInput) as cm:
            core.run_make(self.run_dir, prompt="p", stages=st, only="stage")
        self.assertEqual(str(cm.exception), "missing input: world/marker.txt")
        self.assertEqual(calls, [])

    def test_only_stage_without_ancestor_marker(self):
        core.run_make(self.run_dir, prompt="p")
        (self.run_dir / "brief" / "marker.txt").unlink()
        with self.assertRaises(core.MissingInput) as cm:
            core.run_make(self.run_dir, prompt="p", only="stage")
        self.assertEqual(str(cm.exception), "missing input: brief/marker.txt")


class TestAtomicPublish(Base):
    def test_stage_dir_never_absent_on_republish(self):
        core.run_make(self.run_dir, prompt="p")
        final = self.run_dir / "stage"
        gaps = []
        real = os.replace

        def spy(a, b, *k, **kw):
            gaps.append(final.is_dir())
            r = real(a, b, *k, **kw)
            gaps.append(final.is_dir())
            return r
        with mock.patch.object(core.os, "replace", spy):
            r = core.run_make(self.run_dir, prompt="p", from_="stage")
        self.assertEqual(r["stage"], "ran")
        self.assertTrue(gaps)
        self.assertTrue(all(gaps), gaps)
        self.assertTrue((final / "marker.txt").is_file())
        r = core.run_make(self.run_dir, prompt="p")
        self.assertEqual(set(r.values()), {"cached"})


class TestStaleLockRace(Base):
    def test_only_one_owner_breaks_stale_lock(self):
        self.run_dir.mkdir(parents=True)
        p = self.run_dir / ".lock"
        p.write_text("99999999")
        read0, unlink0 = Path.read_text, Path.unlink
        tls = threading.local()
        gate = threading.Barrier(2)
        entered = {x: threading.Event() for x in "AB"}
        release = {x: threading.Event() for x in "AB"}
        counts = {x: 0 for x in "AB"}
        errors = []

        def read(path, *a, **k):
            who = getattr(tls, "who", None)
            if path == p and who in counts:
                tls.n += 1
                value = read0(path, *a, **k)
                if tls.n == 2:
                    gate.wait(timeout=3)
                return value
            return read0(path, *a, **k)

        def unlink(path, *a, **k):
            who = getattr(tls, "who", None)
            if path == p and who in counts:
                counts[who] += 1
                if who == "B" and counts[who] == 1:
                    entered["A"].wait(3)
            return unlink0(path, *a, **k)

        def go(who):
            tls.who = who
            tls.n = 0
            try:
                with core._Lock(p):
                    entered[who].set()
                    release[who].wait(3)
            except Exception as e:
                errors.append(e)

        ts = [threading.Thread(target=go, args=(x,)) for x in "AB"]
        with mock.patch.object(Path, "read_text", read), \
                mock.patch.object(Path, "unlink", unlink), \
                mock.patch.object(core, "_pid_alive", lambda _: False):
            try:
                for t in ts:
                    t.start()
                entered["A"].wait(1.5)
                entered["B"].wait(1.5)
                n_in = sum(entered[x].is_set() for x in "AB")
            finally:
                for x in "AB":
                    release[x].set()
                for t in ts:
                    t.join(5)
        self.assertEqual(n_in, 1, errors)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], core.LockError)


class TestBudgetSpent(Base):
    def test_failed_stage_records_spent_usd_and_stops(self):
        def boom(ctx):
            ctx.spend(11.0)
            raise RuntimeError("boom")
        r = core.run_make(self.run_dir, prompt="p", stages=_stages(brief=boom),
                          max_dollars=10)
        self.assertEqual(r["brief"], "failed")
        m = json.loads((self.run_dir / "make.json").read_text())
        self.assertEqual(m["stages"]["brief"]["usd"], 11.0)
        # следующий запуск: сумма трат ≥ D → brief не стартует
        calls = []

        def ok(ctx):
            calls.append(1)
        r = core.run_make(self.run_dir, prompt="p", stages=_stages(brief=ok),
                          max_dollars=10)
        self.assertEqual(r["brief"], "failed")
        self.assertEqual(calls, [])
        m = json.loads((self.run_dir / "make.json").read_text())
        self.assertEqual(m["stages"]["brief"]["reason"], "budget")

    def test_spent_snapshot_under_lock(self):
        orig_put = core._Manifest.put
        orig_spent = core._Manifest.spent if hasattr(core._Manifest, "spent") else None
        self.assertIsNotNone(orig_spent, "_Manifest.spent() must exist")

        def slow_put(self, sid, rec):
            with self.mu:
                self.data["stages"][sid] = rec
                self.save()

        with mock.patch.object(core._Manifest, "put", slow_put):
            r = core.run_make(self.run_dir, prompt="p", max_dollars=100)
        self.assertEqual(r["stage"], "ran")
        del orig_put



from make.testkit import offline_spark_module  # noqa: E402
offline_spark_module(globals())

if __name__ == "__main__":
    unittest.main()

