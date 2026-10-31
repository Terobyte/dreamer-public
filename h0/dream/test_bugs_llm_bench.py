"""Red tests for B52 (paid fallback after the cap) and B53 (batch vs TimeoutExpired).
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


if __name__ == "__main__":
    unittest.main()
