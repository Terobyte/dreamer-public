"""Phase 1.2a contract (spec 7.2 row 1.2a, debt D3): the tick decides when a line
is generated. One generation at a time, no pre-generation ahead of the playing
line, and the first free tick after a line ends happens on that same loop step.
usage: cd h0/dream && python3 -m unittest test_phase1_tick -q
"""

import json
import os
import random
import tempfile
import threading
import unittest
from unittest import mock

from dialogue import Dialogue, TICK
from fake import FakeTransport
from sim import Sim, load_profile
from test_phase1_util import manual_clock, start_turn


def rows(root):
    with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class TickTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))

    def _sim(self, reply="[flat] Nothing to say here.", gate=None):
        self.root = tempfile.mkdtemp()
        transport = FakeTransport(reply=lambda *a: reply, gate=gate)
        dlg = Dialogue(load_profile("A"), transport=transport, rng=random.Random(0))
        dlg.background = False
        # one generation = one hero_line/actor_line call (a call may retry inside)
        self.gens = []
        for name in ("hero_line", "actor_line"):
            fn = getattr(dlg, name)
            setattr(dlg, name, (lambda fn, name: lambda *a, **k: (
                self.gens.append(name), fn(*a, **k))[1])(fn, name))
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        manual_clock(self, sim)
        return sim, transport

    def step(self, sim, join=True):
        """One loop step at the current clock; the caller moves the clock."""
        sim._tick()
        sim._maybe_generate_line()
        th = sim._gen_thread
        if join and th is not None and th.is_alive():
            th.join(2)

    def test_no_second_generation_in_flight(self):
        gate = threading.Event()
        sim, transport = self._sim(gate=gate)
        self.addCleanup(gate.set)
        start_turn(self, sim, join=False)
        self.assertTrue(transport.entered.wait(5), "the first call never started")
        for _ in range(7):
            self.now += sim.clock.scale(TICK)
            self.step(sim, join=False)
        self.assertEqual(len(self.gens), 1, "a second generation started in flight")
        gate.set()
        sim._gen_thread.join(2)

    def test_generations_spaced_by_tick(self):
        sim, _ = self._sim(reply="[flat] No.")
        start_turn(self, sim)
        self.now += 0.01
        sim._tick()
        sim._maybe_generate_line()
        self.assertIsNotNone(sim.active_line)
        self.assertEqual(len(self.gens), 1, "pre-generation while a line plays")
        # just before the line ends there is still no pre-generation ...
        start, dur = sim._line_started_at, sim._line_duration
        self.now = start + dur - 0.01
        sim._tick()
        sim._maybe_generate_line()
        self.assertIsNotNone(sim.active_line)
        self.assertEqual(len(self.gens), 1, "pre-generation while a line plays")
        # ... and the step that ends the line is itself a free tick
        self.now = start + dur + 0.01
        sim._tick()
        sim._maybe_generate_line()
        th = sim._gen_thread
        if th is not None and th.is_alive():
            th.join(2)
        self.assertEqual(len(self.gens), 2,
                         "no generation on the step the line ended")

    def test_first_free_tick_immediate(self):
        sim, transport = self._sim()
        start_turn(self, sim)
        self.assertEqual(len(self.gens), 1)
        # the line is taken on the next step and starts playing
        self.now += sim.clock.scale(TICK)
        self.step(sim)
        self.assertIsNotNone(sim.active_line)
        self.assertEqual(len(self.gens), 1, "no pre-generation while a line plays")
        for _ in range(2):
            self.now += sim.clock.scale(TICK)
            self.step(sim)
            if sim.active_line is None:
                break
            self.assertEqual(len(self.gens), 1, "no pre-generation while a line plays")
        else:
            self.fail("the line never ended")
        # the step that ended the line is itself a free tick: generation started
        self.assertEqual(len(self.gens), 2, "the first free tick was not immediate")
        self.step(sim)
        self.assertEqual(len(self.gens), 2, "a second generation inside one tick")

    def test_human_discards_in_flight(self):
        gate = threading.Event()
        sim, transport = self._sim(reply="[flat] Nothing to say here.", gate=gate)
        start_turn(self, sim, join=False)
        self.assertTrue(transport.entered.wait(5), "the first call never started")
        sim.human_say("stop")
        gate.set()
        sim._gen_thread.join(2)
        sim._maybe_generate_line()
        log = rows(self.root)
        discarded = [r for r in log if r["type"] == "line_discarded"]
        self.assertEqual(len(discarded), 1, "the in-flight line was not discarded")
        self.assertEqual(discarded[0]["reason"], "human")
        self.assertIn(discarded[0]["who"], [sim.hero] + list(sim.actors))
        said = [r["text"] for r in log if r["type"] == "line"]
        self.assertTrue(all("Nothing to say here" not in t for t in said),
                        "the discarded line was spoken anyway")


if __name__ == "__main__":
    unittest.main()
