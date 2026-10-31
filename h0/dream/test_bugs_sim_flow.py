"""Regression tests for simulation flow bugs B49, B51, and B60."""
import json
import os
import tempfile
import threading
import unittest
from unittest import mock

import llm
import sim as S
from dialogue import Dialogue
from fake import FakeTransport
from test_book_play import BOOK


class SimFlowBugTests(unittest.TestCase):
    def test_B49_slow_voice_does_not_block_tick_loop(self):
        entered, release, started = threading.Event(), threading.Event(), threading.Event()

        class Voice:
            def synthesize(self, *args):
                entered.set()
                release.wait()
                return {"ok": False, "pause": 0.0}

        sim = S.Sim(profile="A", fake=False, outdir=tempfile.mkdtemp(), media={"voice": Voice()})
        self.addCleanup(sim.close)
        returned = threading.Event()
        worker = threading.Thread(target=lambda: (sim._start_line({"owner": "npc", "text": "hello"}), returned.set()))
        worker.start()
        self.addCleanup(lambda: (release.set(), worker.join(2)))
        self.assertTrue(entered.wait(2))
        sim.submit("stop")
        sim._tick()
        started.set()
        self.assertTrue(returned.wait(0), "_start_line blocks on voice synthesis; the loop cannot advance")
        self.assertTrue(started.is_set())

    def test_B51_final_cost_row_waits_for_dialogue_fold(self):
        llm.reset_spent()
        self.addCleanup(llm.reset_spent)
        release, entered = threading.Event(), threading.Event()
        dlg = Dialogue(S.load_profile("A"), transport=FakeTransport(reply=lambda *a: "[flat] No."))
        dlg.background = False
        sim = S.Sim(profile="A", fake=True, outdir=tempfile.mkdtemp(), dialogue=dlg)
        self.addCleanup(sim.close)

        def fold_worker():
            entered.set()
            release.wait()
            llm._charge(0.0123)

        worker = threading.Thread(target=fold_worker, daemon=True)
        dlg._mind_threads.append(worker)
        worker.start()
        self.assertTrue(entered.wait(2))
        sim.run(max_transitions=1, max_seconds=0.0)
        with open(os.path.join(sim.outdir, "log.jsonl"), encoding="utf-8") as f:
            costs = [json.loads(line)["dollars"] for line in f if json.loads(line)["type"] == "cost"]
        release.set()
        worker.join(2)
        self.assertAlmostEqual(costs[-1], llm.get_spent(), places=6,
                               msg="the final cost row misses the Dialogue fold charge")

    def test_B60_book_line_event_preserves_beat_fields(self):
        plan = S._load_book_plan(BOOK, ["library"])
        S.use_scene(plan["scenes"][0]["dict"])
        beat = {"kind": "line", "who": "Ashley Wilkes", "text": "Wait.", "para": 7,
                "stage": "at the doorway", "gesture": "raises a hand", "shot": "close-up"}
        plan["scenes"][0]["beats"] = [beat]
        self.addCleanup(S.use_scene, "start")
        sim = S.Sim(profile=None, fake=True, speed=50, outdir=tempfile.mkdtemp(), book=plan, script=[])
        self.addCleanup(sim.close)
        sim._book_step()
        with open(os.path.join(sim.outdir, "log.jsonl"), encoding="utf-8") as f:
            events = [json.loads(line) for line in f]
        line = next(row for row in events if row["type"] == "line")
        self.assertEqual({k: line.get(k) for k in ("stage", "gesture", "shot")},
                         {"stage": "at the doorway", "gesture": "raises a hand", "shot": "close-up"})
        S.use_scene("start")


if __name__ == "__main__":
    unittest.main()
