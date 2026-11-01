"""Regression tests for B52 (paid fallback after the cap) and B53 (batch vs TimeoutExpired).
usage: cd h0/dream && python3 -m pytest -q test_bugs_llm_bench.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import llm
import bank
import sim as S

HERE = os.path.dirname(os.path.abspath(__file__))


def _msgs():
    return [{"role": "user", "content": "hi"}]


class B52CapBlocksPaidFallback(unittest.TestCase):
    """B52: once the cap is reached, a Spark Open role call whose Baseten primary
    fails must not fall back to the paid Spark 1.3 (META_API)."""

    def setUp(self):
        self.previous_spent = llm.get_spent()
        self.addCleanup(llm._spent.__setitem__, 0, self.previous_spent)
        self.addCleanup(llm.set_cap, None)
        llm.reset_spent()
        llm._charge(1.0)
        llm.set_cap(1.0)
        self.meta_calls = []
        self.enterContext(mock.patch.object(llm, "_post", side_effect=self._post))
        self.enterContext(mock.patch.object(llm, "_baseten_key", return_value="test-key"))
        self.enterContext(mock.patch.dict(os.environ, {"META_MODEL_API_KEY": "test-key"}))
        self.enterContext(mock.patch.object(llm.urllib.request, "urlopen",
                                           side_effect=AssertionError("network forbidden")))

    def _post(self, url, *args):
        if url == llm.BASETEN_API:
            raise OSError("baseten unavailable: 503")
        self.meta_calls.append(url)
        return {"content": "paid fallback reply",
                "usage": {"prompt_tokens": 100, "completion_tokens": 10}}

    def test_B52_spark_open_fallback_respects_cap(self):
        spent_before = llm.get_spent()
        with self.assertLogs("llm", level="WARNING"):
            result = llm.call("hero", "system", _msgs())
        self.assertEqual(self.meta_calls, [],
                         "B52: cap reached, yet the paid Spark 1.3 fallback was called")
        self.assertAlmostEqual(llm.get_spent(), spent_before,
                               msg="B52: paid fallback was charged past the cap")
        self.assertEqual(result.text, "")


class B53BatchSurvivesTimeout(unittest.TestCase):
    """B53: one run hitting TimeoutExpired in bank.run_scene must not kill the
    whole batch; the completed run is still reported in the sheet."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ok_dir = os.path.join(self.root, "run_ok")
        os.makedirs(self.ok_dir)
        with open(os.path.join(self.ok_dir, "log.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "line", "who": "Max", "role": "hero",
                                "text": "Hello.", "remarks": []}) + "\n")

    def _fake_run(self, cmd, **kwargs):
        scene = cmd[cmd.index("--scene") + 1]
        if scene == "ok":
            return mock.Mock(returncode=0, stdout="outdir=%s transitions=1 files=1 spent=0\n"
                             % self.ok_dir, stderr="")
        raise subprocess.TimeoutExpired(cmd, 1200)

    def test_B53_timeout_in_one_run_keeps_completed_runs(self):
        sheet = os.path.join(self.root, "sheet.md")
        argv = ["bank.py", "--scenes", "ok,slow", "--talk", "spark-open", "--runs", "1",
                "--max-dollars", "0.01", "--out", sheet]
        with mock.patch.dict(os.environ, {bank.BENCH_ENV: "1"}), \
             mock.patch.object(sys, "argv", argv), \
             mock.patch("bank.subprocess.run", side_effect=self._fake_run), \
             mock.patch("bench_f1.load_ledger", return_value=[]):
            # B53: today TimeoutExpired escapes ex.map and main() raises here
            bank.main()
        self.assertTrue(os.path.exists(sheet), "B53: no sheet written after a timeout")
        with open(sheet, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("## ok  (run_ok)", text,
                      "B53: the completed run is missing from the sheet")
        self.assertIn("## slow", text, "B53: the timed-out run is not reported as failed")


class B53LedgerDoesNotOverchargeTimeout(unittest.TestCase):
    """F1: timed-out run has no run= dir, ledger must not charge cap*missing."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.ok_dir = os.path.join(self.tmp, "run_ok")
        os.makedirs(self.ok_dir)
        # minimal log that scores to spent=0
        with open(os.path.join(self.ok_dir, "log.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "line", "who": "Max", "role": "hero",
                                "text": "Hello.", "remarks": []}) + "\n")
            f.write(json.dumps({"type": "cost", "dollars": 0.0}) + "\n")
        self.ledger = os.path.join(self.tmp, "ledger.jsonl")
        self.out = os.path.join(self.tmp, "out")

    def test_B53_ledger_timeout_zero_not_cap(self):
        import bench_f1
        cap = 0.20
        # bank stdout: one completed run, one timeout marker
        fake_stdout = "run=%s\ntimeout=slow\nsheet=%s/f1_1_0_fake.md\n" % (self.ok_dir, self.out)
        fake_proc = mock.Mock(returncode=0, stdout=fake_stdout, stderr="")

        def fake_run(cmd, **kwargs):
            # only intercept the bank.py call from bench_f1
            if "bank.py" in " ".join(cmd):
                return fake_proc
            raise AssertionError("unexpected subprocess call %r" % cmd)

        argv = ["bench_f1.py", "--step", "1.0", "--runs", "2", "--cap", str(cap),
                "--ledger", self.ledger, "--out", self.out]
        with mock.patch("bench_f1.subprocess.run", side_effect=fake_run), \
             mock.patch.object(sys, "argv", argv):
            rc = bench_f1.main(argv[1:])
        self.assertEqual(rc, 1, "bench incomplete should return 1")
        with open(self.ledger, encoding="utf-8") as f:
            rec = json.loads(f.readline())
        # F1: timeout has no recorded spend -> ledger must charge 0, not cap*missing
        self.assertEqual(rec["dollars"], 0.0,
                         "F1: timed-out run charged $%.4f, expected $0.0 (cap $%.2f * missing counted)" % (rec["dollars"], cap))
        self.assertEqual(rec["gate"], "incomplete")


class B53LedgerTimeoutWithSpend(unittest.TestCase):
    """F2: timed-out run that already wrote cost must be charged its spend, not $0."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.ok_dir = os.path.join(self.tmp, "run_ok")
        os.makedirs(self.ok_dir)
        with open(os.path.join(self.ok_dir, "log.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "line", "who": "Max", "role": "hero",
                                "text": "Hello.", "remarks": []}) + "\n")
            f.write(json.dumps({"type": "cost", "dollars": 0.0}) + "\n")
        self.ledger = os.path.join(self.tmp, "ledger.jsonl")
        self.out = os.path.join(self.tmp, "out")

    def test_B53_ledger_timeout_charges_recorded_spend(self):
        import bench_f1
        cap = 0.20
        spent_timeout = 0.07
        # bank reports timeout with its recorded spend; ledger must charge that, not $0 nor cap
        fake_stdout = "run=%s\ntimeout=slow spent=%.4f\nsheet=%s/f1_1_0_fake.md\n" % (
            self.ok_dir, spent_timeout, self.out)
        fake_proc = mock.Mock(returncode=0, stdout=fake_stdout, stderr="")

        def fake_run(cmd, **kwargs):
            if "bank.py" in " ".join(cmd):
                return fake_proc
            raise AssertionError("unexpected subprocess call %r" % cmd)

        argv = ["bench_f1.py", "--step", "1.0", "--runs", "2", "--cap", str(cap),
                "--ledger", self.ledger, "--out", self.out]
        with mock.patch("bench_f1.subprocess.run", side_effect=fake_run), \
             mock.patch.object(sys, "argv", argv):
            rc = bench_f1.main(argv[1:])
        self.assertEqual(rc, 1)
        with open(self.ledger, encoding="utf-8") as f:
            rec = json.loads(f.readline())
        self.assertAlmostEqual(rec["dollars"], spent_timeout, places=4,
                               msg="F2: timeout with $%.4f spend charged $%.4f, expected $%.4f" % (
                                   spent_timeout, rec["dollars"], spent_timeout))
        self.assertEqual(rec["gate"], "incomplete")


class B53BankPreservesPartialSpend(unittest.TestCase):
    """F2: bank.run_scene must not discard TimeoutExpired partial output that already contains cost."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.partial_dir = os.path.join(self.tmp, "run_partial")
        os.makedirs(self.partial_dir)
        with open(os.path.join(self.partial_dir, "log.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "line", "who": "Max", "role": "hero",
                                "text": "Hi.", "remarks": []}) + "\n")
            f.write(json.dumps({"type": "cost", "dollars": 0.05}) + "\n")

    def test_B53_bank_timeout_keeps_partial_spend(self):
        partial_out = "outdir=%s\nsome other\n" % self.partial_dir
        exc = subprocess.TimeoutExpired(cmd=["sim.py"], timeout=1200, output=None)
        # subprocess.TimeoutExpired stores stdout/stderr via output/stdout attrs
        exc.stdout = partial_out
        exc.stderr = ""
        with mock.patch("bank.subprocess.run", side_effect=exc):
            rundir, log = bank.run_scene("slow", 0.20, 8)
        self.assertIsNone(rundir, "B53: timed-out run must be reported as failed")
        self.assertIn("timed out", log)
        # the partial spend must be recoverable from the log for bench accounting
        self.assertIn("%.4f" % 0.05, log,
                      "B53: bank must preserve partial spend %.4f in timeout log, got %r" % (0.05, log))

    def test_B53_bank_timeout_bytes_partial_output(self):
        # F4: TimeoutExpired.stdout is bytes even with text=True
        partial_out = ("outdir=%s\nsome other\n" % self.partial_dir).encode("utf-8")
        exc = subprocess.TimeoutExpired(cmd=["sim.py"], timeout=1200, output=partial_out,
                                        stderr=b"")
        with mock.patch("bank.subprocess.run", side_effect=exc):
            rundir, log = bank.run_scene("slow", 0.20, 8)
        self.assertIsNone(rundir)
        self.assertIn("partial_spent=0.0500", log,
                      "F4: bytes partial output lost the recorded spend, got %r" % log)

    def test_F2_timeout_before_outdir_line_uses_early_rundir(self):
        # a hung sim never reaches its final outdir= print; rundir= is out first
        exc = subprocess.TimeoutExpired(cmd=["sim.py"], timeout=1200,
                                        output=("rundir=%s\n" % self.partial_dir).encode("utf-8"),
                                        stderr=b"")
        with mock.patch("bank.subprocess.run", side_effect=exc):
            rundir, log = bank.run_scene("slow", 0.20, 8)
        self.assertIsNone(rundir)
        self.assertIn("partial_spent=0.0500", log)

    def test_F2_sim_prints_rundir_before_the_dream_runs(self):
        seen = []
        with mock.patch.object(S, "Sim", side_effect=RuntimeError("hung")):
            with self.assertRaises(RuntimeError):
                S.run(profile="A", fake=True, label="test_rundir", on_outdir=seen.append)
        self.assertEqual(len(seen), 1)
        self.assertTrue(os.path.isdir(seen[0]))
        shutil.rmtree(os.path.dirname(seen[0]), True)


if __name__ == "__main__":
    unittest.main()
