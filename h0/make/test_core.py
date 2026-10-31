"""M0: каркас make — манифест, хэш, DAG, лок, деньги. Сеть не нужна."""
import dataclasses
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from make import core

ROOT = Path(__file__).resolve().parents[2]


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.run_dir = Path(self._tmp.name) / "run"
        self.calls = []
        self.lk = threading.Lock()

    def stages(self, **over):
        """заглушки с учётом вызовов; over: id -> fn(ctx) или dict полей Stage"""
        out = {}
        for sid, st in core.default_stages().items():
            inner = over.get(sid, st.fn)
            if isinstance(inner, dict):
                st = dataclasses.replace(st, **inner)
                inner = st.fn

            def fn(ctx, _sid=sid, _inner=inner):
                with self.lk:
                    self.calls.append(_sid)
                return _inner(ctx)
            out[sid] = dataclasses.replace(st, fn=fn)
        return out

    def make(self, stages=None, **kw):
        kw.setdefault("prompt", "p")
        return core.run_make(self.run_dir, stages=stages or self.stages(), **kw)

    def manifest(self):
        return json.loads((self.run_dir / "make.json").read_text())


class TestManifestHash(Base):
    def test_full_run_then_cached(self):
        self.make()
        m = self.manifest()
        self.assertEqual(m["prompt"], "p")
        for sid in ("brief", "refs", "world", "cast", "story", "stage"):
            self.assertEqual(m["stages"][sid]["status"], "ok", sid)
            self.assertEqual(len(m["stages"][sid]["input_hash"]), 64)
            self.assertTrue((self.run_dir / sid).is_dir())
            self.assertFalse((self.run_dir / (sid + ".tmp")).exists())
        self.assertNotIn("check", m["stages"])
        n = len(self.calls)
        self.make()
        self.assertEqual(len(self.calls), n)

    def test_hash_formula(self):
        want = hashlib.sha256(json.dumps(
            {"stage": "s", "version": 2, "params": {"a": 1},
             "inputs": [["x/f", "ab"]]},
            sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(core.input_hash("s", 2, {"a": 1}, [["x/f", "ab"]]), want)
        self.make()
        st = core.default_stages()["brief"]
        self.assertEqual(
            self.manifest()["stages"]["brief"]["input_hash"],
            core.input_hash("brief", st.version, {"fake": False, "prompt": "p"}, []))

    def test_changed_input_file_reruns_descendants(self):
        self.make()
        self.calls.clear()
        (self.run_dir / "refs" / "marker.txt").write_text("edited")
        self.make()
        self.assertEqual(sorted(self.calls), ["cast", "stage", "story", "world"])

    def test_version_bump(self):
        self.make()
        self.calls.clear()
        self.make(stages=self.stages(cast={"version": 99}))
        self.assertEqual(sorted(self.calls), ["cast", "stage"])

    def test_fake_flag_in_params(self):
        self.make()
        self.calls.clear()
        self.make(fake=True)
        self.assertEqual(len(self.calls), 6)


class TestFailure(Base):
    def boom(self, ctx):
        (ctx.out / "partial.txt").write_text("x")
        raise RuntimeError("boom")

    def test_failed_stage_keeps_tmp_and_retry_cleans(self):
        res = self.make(stages=self.stages(cast=self.boom))
        self.assertEqual(res["cast"], "failed")
        self.assertEqual(self.manifest()["stages"]["cast"]["status"], "failed")
        self.assertTrue((self.run_dir / "cast.tmp" / "partial.txt").exists())
        self.assertFalse((self.run_dir / "cast").exists())
        self.assertNotIn("stage", self.manifest()["stages"])
        seen = {}

        def ok(ctx):
            seen["leftover"] = (ctx.out / "partial.txt").exists()
            seen["resume"] = ctx.resume
        self.make(stages=self.stages(cast=ok))
        self.assertEqual(seen, {"leftover": False, "resume": False})
        self.assertFalse((self.run_dir / "cast.tmp").exists())
        self.assertEqual(self.manifest()["stages"]["stage"]["status"], "ok")

    def test_world_tmp_survives_for_resume(self):
        self.make(stages=self.stages(world=self.boom))
        self.assertTrue((self.run_dir / "world.tmp" / "partial.txt").exists())
        seen = {}

        def ok(ctx):
            seen["leftover"] = (ctx.out / "partial.txt").exists()
            seen["resume"] = ctx.resume
        self.make(stages=self.stages(world=ok))
        self.assertEqual(seen, {"leftover": True, "resume": True})

    def test_fresh_drops_world_tmp(self):
        self.make(stages=self.stages(world=self.boom))
        seen = {}

        def ok(ctx):
            seen["leftover"] = (ctx.out / "partial.txt").exists()
            seen["resume"] = ctx.resume
        self.make(stages=self.stages(world=ok), from_="world", fresh=True)
        self.assertEqual(seen, {"leftover": False, "resume": False})


class TestSelection(Base):
    def test_from_reruns_descendants_not_ancestors(self):
        self.make()
        self.calls.clear()
        self.make(from_="story")
        self.assertEqual(sorted(self.calls), ["stage", "story"])

    def test_only_missing_input(self):
        with self.assertRaises(core.MissingInput) as cm:
            self.make(only="stage")
        self.assertTrue(str(cm.exception).startswith("missing input: world/"))
        self.assertEqual(self.calls, [])

    def test_only_runs_single(self):
        self.make()
        self.calls.clear()
        (self.run_dir / "refs" / "marker.txt").write_text("edited")
        self.make(only="world")
        self.assertEqual(self.calls, ["world"])

    def test_until(self):
        self.make(until="refs")
        self.assertEqual(sorted(self.calls), ["brief", "refs"])

    def test_parallel_stubs_overlap(self):
        self.make()
        iv = []
        for sid in ("world", "cast", "story"):
            d = json.loads((self.run_dir / sid / "marker.txt").read_text())
            iv.append((d["start"], d["end"]))
        self.assertLess(max(s for s, _ in iv), min(e for _, e in iv))


class TestLock(Base):
    def test_second_process_errors(self):
        self.run_dir.mkdir(parents=True)
        (self.run_dir / ".lock").write_text(str(os.getpid()))
        with self.assertRaises(core.LockError):
            self.make()
        self.assertEqual(self.calls, [])

    def test_incomplete_lock_is_locked(self):
        self.run_dir.mkdir(parents=True)
        (self.run_dir / ".lock").write_text("")
        with self.assertRaises(core.LockError):
            self.make()
        self.assertEqual(self.calls, [])
        self.assertTrue((self.run_dir / ".lock").exists())

    def test_dead_pid_lock_removed(self):
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.run_dir.mkdir(parents=True)
        (self.run_dir / ".lock").write_text(str(p.pid))
        self.make()
        self.assertEqual(self.manifest()["stages"]["stage"]["status"], "ok")
        self.assertFalse((self.run_dir / ".lock").exists())


class TestBudget(Base):
    def test_split_parse_and_shares(self):
        sp = core.parse_split("world=50,cast=25")
        self.assertEqual(sp["world"], 50)
        self.assertEqual(sp["brief"], 2)
        seen = {}

        def grab(ctx):
            seen["w"] = ctx.budget_usd
        self.make(stages=self.stages(world=grab), max_dollars=10)
        self.assertAlmostEqual(seen["w"], 7.0)

    def test_stop_new_stages_at_budget(self):
        def spend(ctx):
            return 11.0
        res = self.make(stages=self.stages(brief=spend), max_dollars=10)
        self.assertEqual(res["brief"], "ran")
        self.assertEqual(self.manifest()["stages"]["brief"]["usd"], 11.0)
        self.assertEqual(res["refs"], "failed")
        r = self.manifest()["stages"]["refs"]
        self.assertEqual((r["status"], r["reason"]), ("failed", "budget"))
        self.assertEqual(self.calls, ["brief"])


class TestGitignore(unittest.TestCase):
    def test_lines(self):
        lines = (ROOT / ".gitignore").read_text().splitlines()
        self.assertIn("runs/", lines)
        self.assertIn("!h0/make/testdata/**/dist/", lines)



from make.testkit import offline_spark_module  # noqa: E402
offline_spark_module(globals())

if __name__ == "__main__":
    unittest.main()

