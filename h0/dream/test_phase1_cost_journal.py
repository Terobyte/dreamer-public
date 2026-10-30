"""Debt Д7 (bench r2): the last `cost` row of a run must hold every dollar the run spent.

Two Ф1 runs and the 1.5 spike died in sim.verify_run on "actual spent != journal cost":
the loop end waited 5 s for the director's consult (a Wonder consult took 23 s), wrote
the final cost row, and the consult charged llm after it; the goal judge and a line in
flight were not joined at all. Offline: the paid workers are threads behind a gate.
usage: cd h0/dream && python3 -m unittest test_phase1_cost_journal -q
"""

import json
import os
import random
import tempfile
import threading
import unittest
from unittest import mock

import llm
from dialogue import Dialogue
from fake import FakeTransport
from sim import Sim, load_profile
from test_phase1_util import manual_clock


def _rows(root):
    with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class CostJournalTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        llm.reset_spent()
        self.addCleanup(llm.reset_spent)
        self.root = tempfile.mkdtemp()
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=lambda *a: "[flat] No."),
                       rng=random.Random(0))
        dlg.background = False
        self.sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(self.sim.close)
        self.enterContext(mock.patch.object(self.sim.director, "consult_async"))
        manual_clock(self, self.sim)

    def _paid_worker(self, dollars, after=0.3):
        """A thread that charges llm `after` seconds, like a slow paid call."""
        gate = threading.Event()
        self.addCleanup(gate.set)

        def work():
            gate.wait(5)
            llm._charge(dollars)
        th = threading.Thread(target=work, daemon=True)
        th.start()
        threading.Timer(after, gate.set).start()
        return th

    def _last_cost(self, th):
        """The worker has charged for sure once joined: only then is get_spent the truth."""
        th.join(5)
        self.assertFalse(th.is_alive(), "the paid worker never finished")
        costs = [r["dollars"] for r in _rows(self.root) if r["type"] == "cost"]
        self.assertTrue(costs, "no cost row at the end of the run")
        return costs[-1]

    def test_final_cost_row_waits_for_the_goal_judge(self):
        th = self.sim._judge_thread = self._paid_worker(0.0123)
        # max_seconds 0: the loop ends on its first check while the judge is in flight
        self.sim.run(max_transitions=1, max_seconds=0.0)
        self.assertAlmostEqual(self._last_cost(th), llm.get_spent(), places=6,
                               msg="the last cost row misses the dollars of the judge in flight")

    def test_final_cost_row_waits_for_the_director_without_a_timeout(self):
        th = self.sim.director._thread = self._paid_worker(0.0456)
        with mock.patch.object(self.sim.director, "wait", wraps=self.sim.director.wait) as w:
            self.sim.run(max_transitions=1, max_seconds=0.0)
        self.assertIn(mock.call(timeout=None), w.call_args_list,
                      "the loop end must join the director's consult with no timeout")
        self.assertAlmostEqual(self._last_cost(th), llm.get_spent(), places=6)

    def test_final_cost_row_waits_for_the_line_in_flight(self):
        th = self.sim._gen_thread = self._paid_worker(0.0789)
        self.sim.run(max_transitions=1, max_seconds=0.0)
        self.assertAlmostEqual(self._last_cost(th), llm.get_spent(), places=6,
                               msg="the last cost row misses the dollars of the line in flight")


if __name__ == "__main__":
    unittest.main()
