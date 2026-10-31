"""Regression tests for the human and world-event queues (B43, B46, B47)."""

import os
import random
import tempfile
import unittest
from unittest import mock

from dialogue import Dialogue, TICK
from fake import FakeTransport
from sim import Sim, load_profile
from test_phase1_util import manual_clock


class SimQueueBugTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.root = tempfile.mkdtemp()
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=lambda *a: ""),
                       rng=random.Random(0))
        dlg.background = False
        self.sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root,
                       dialogue=dlg)
        self.addCleanup(self.sim.close)
        self.enterContext(mock.patch.object(self.sim.director, "consult_async"))
        manual_clock(self, self.sim)

    def test_B43_queued_human_line_starts_after_pending_narration(self):
        sim = self.sim
        sim._narrate.append({"cause": "transition", "context": {}})
        sim.human_say("I am here")
        # Exercise the loop while narration is pending, then let narration finish.
        sim._cycle_line()
        sim._dialogue_turn()
        sim._narrating = False
        for _ in range(3):
            sim._cycle_line()
            sim._dialogue_turn()
        self.assertIsNotNone(sim.active_line, "queued human line never starts after narration")
        self.assertEqual(sim.active_line.get("text"), "I am here")

    def test_B46_second_human_line_does_not_overwrite_queued_first(self):
        self.sim.human_say("first line")
        self.sim.human_say("second line")
        self.assertEqual(self.sim.next_line["text"], "first line")

    def test_B47_turn_skip_preserves_consumed_actor_event(self):
        sim = self.sim
        actor = sim.actors[0]
        sim._pending[actor] = ["the door just opened"]
        sim._pick_speaker = lambda: (actor, "actor")
        received = []
        sim.dialogue.actor_line = lambda who, world, transcript, state, notes, events, persona: (
            received.extend(events), None)[1]
        sim._last_tick = -1e9
        sim._maybe_generate_line()
        sim._gen_thread.join(2)
        sim._dialogue_turn()
        self.assertEqual(sim._pending.get(actor), ["the door just opened"])


if __name__ == "__main__":
    unittest.main()
