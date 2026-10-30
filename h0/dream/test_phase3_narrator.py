"""Phase 3.2: the narrator voices what nobody in the scene can say -- a transition
and an event nobody sees (spec 7.2 row 3.2).
usage: cd h0/dream && python3 -m unittest -q test_phase3_narrator
Offline: every call goes through FakeTransport, nothing touches the network."""

import os
import tempfile
import unittest
from unittest import mock

import llm
import sim as S
from dialogue import Dialogue
from fake import FakeTransport
from sim import load_profile
from test_phase1_util import manual_clock, pump

HERE = os.path.dirname(os.path.abspath(__file__))
MEM_REPLY = ("SO FAR: the three of them argued on the roof all night.\n"
             "KNOW: Max lost his job\nPROMISED: none\n"
             "TRIED: [1] Dan: the ledge; [2] Maya: the warehouse")
POOL = ("the wind is cold up here tonight.",
        "my shoes are soaked through already.",
        "somebody left a chair by that coop.",
        "i counted eleven planes before you came.",
        "there is grain all over the floor.",
        "the lift has been broken since spring.",
        "a dog is barking down on the street.",
        "my phone died an hour ago.",
        "those birds know me by now.",
        "it smells like rain and tar.")
NARRATION = "Somewhere below, a door closes on its own."


class NarratorBase(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        S.use_scene("roof3")
        self.addCleanup(S.use_scene, "start")
        self.said = 0

    def _reply(self, model, effort, system, messages):
        """FakeTransport.reply tells the roles apart by the system prompt."""
        if "TRIED:" in system:
            return MEM_REPLY
        if "narrator" in system.lower():
            return NARRATION
        self.said += 1
        return "[quiet] %s" % POOL[self.said % len(POOL)]

    def _sim(self):
        root = tempfile.mkdtemp()
        self.ft = FakeTransport(reply=self._reply)
        dlg = Dialogue(load_profile("A"), transport=self.ft)
        dlg.background = False
        sim = S.Sim(profile="A", fake=True, speed=1.0, outdir=root, dialogue=dlg)
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        manual_clock(self, sim)
        self.rows = []
        inner = sim.logger.write_event
        self.enterContext(mock.patch.object(
            sim.logger, "write_event",
            side_effect=lambda ev: (self.rows.append(dict(ev)), inner(ev))[1]))
        return sim

    def _kinds(self, kind):
        return [r for r in self.rows if r.get("type") == kind]

    def _pump_until(self, sim, cond, ticks=400):
        for _ in range(ticks):
            if cond():
                return True
            pump(sim)
        return cond()


class Narrator(NarratorBase):
    def test_narrator_role_open(self):
        self.assertEqual(llm.resolve("narrator"), (llm.SPARK_OPEN_MODEL, "minimal"))

    def test_narrator_on_transition(self):
        sim = self._sim()
        self.assertTrue(self._pump_until(sim, lambda: self._kinds("line")),
                        "no line in the first scene")
        before = len(self.rows)
        sim.fsm.next_scene = {"objects": ["long table", "wet window"],
                              "actors": [{"name": "Vera", "voice": "woman",
                                          "persona": "a cook who never sits down"}],
                              "events": [], "goals": []}
        sim.fsm.destination = "a kitchen at dawn"
        sim._apply_transition()
        self.assertTrue(self._pump_until(sim, lambda: any(
            r["type"] == "line" for r in self.rows[before:])), "no line after transition")
        tail = self.rows[before:]
        narr = [r for r in tail if r["type"] == "narrator"]
        self.assertEqual(len(narr), 1, [r["type"] for r in tail])
        self.assertEqual(narr[0]["cause"], "transition")
        self.assertTrue(narr[0]["text"])
        self.assertIn("t", narr[0])
        first_line = next(i for i, r in enumerate(tail) if r["type"] == "line")
        self.assertLess(tail.index(narr[0]), first_line,
                        "the narrator must speak before the first line of the scene")

    def test_narrator_before_human_line_after_transition(self):
        # F1: a human line arriving while the transition narration is still
        # in flight must wait for it -- the narrator speaks before the first
        # line of the new scene.
        import threading
        sim = self._sim()
        self.assertTrue(self._pump_until(sim, lambda: self._kinds("line")),
                        "no line in the first scene")
        before = len(self.rows)
        gate = threading.Event()
        self.addCleanup(gate.set)
        sim.dialogue.narrate = lambda *a: (gate.wait(3), NARRATION)[1]
        sim.fsm.next_scene = {"objects": ["long table", "wet window"],
                              "actors": [{"name": "Vera", "voice": "woman",
                                          "persona": "a cook who never sits down"}],
                              "events": [], "goals": []}
        sim.fsm.destination = "a kitchen at dawn"
        sim._apply_transition()
        self.now += sim.clock.scale(4)
        sim._tick()
        sim._maybe_generate_line()
        sim.human_say("I am here.")
        sim._tick()
        gate.set()
        th = sim._gen_thread
        if th is not None:
            th.join(2)
        sim._maybe_generate_line()
        sim._tick()
        order = [r["type"] for r in self.rows[before:]
                 if r.get("type") in ("line", "narrator")]
        self.assertIn("narrator", order, order)
        self.assertIn("line", order, order)
        self.assertLess(order.index("narrator"), order.index("line"), order)

    def test_narrator_on_unseen_event(self):
        sim = self._sim()
        sim._schedule = [{"t": 0.0, "what": "a light goes out in the stairwell",
                          "who": [], "kind": "world"}]
        sim._fired = set()
        sim.scene_start = sim.clock.now()
        self.assertTrue(self._pump_until(sim, lambda: self._kinds("narrator")),
                        "no narration for an event nobody sees")
        narr = self._kinds("narrator")
        self.assertEqual(len(narr), 1)
        self.assertEqual(narr[0]["cause"], "event")
        # an event with a recipient is his to voice: the narrator stays quiet
        mark = len(self.rows)
        sim._schedule = [{"t": 0.0, "what": "Maya's phone rings",
                          "who": ["Maya"], "kind": "world"}]
        sim._fired = set()
        sim.scene_start = sim.clock.now()
        self.assertTrue(self._pump_until(sim, lambda: any(
            r["type"] == "line" for r in self.rows[mark:])), "no line after the event")
        self.assertEqual([r for r in self.rows[mark:] if r["type"] == "narrator"], [])

    def test_narrator_rate(self):
        sim = self._sim()
        lines = sim.line_count
        sim._schedule = [{"t": 0.0, "what": "a light goes out", "who": [],
                          "kind": "world"},
                         {"t": 0.0, "what": "rain starts on the far side", "who": [],
                          "kind": "world"}]
        sim._fired = set()
        sim.scene_start = sim.clock.now()
        self.assertTrue(self._pump_until(
            sim, lambda: len(self._kinds("narrator")) >= 2), "two events, one narration")
        self.assertTrue(self._pump_until(sim, lambda: self._kinds("line")), "no line")
        # one reply per event, never more
        self.assertEqual(len(self._kinds("narrator")), 2)
        for r in self._kinds("narrator"):
            self.assertEqual(r["cause"], "event")
        # a narration is no line: it does not count, does not move the pressure
        # state and is never voiced as a `line`
        self.assertEqual(sim.line_count - lines, len(self._kinds("line")))
        for r in self._kinds("line"):
            self.assertNotEqual(r.get("role"), "narrator")
            self.assertNotEqual(r.get("text"), NARRATION)
        self.assertIsNone(sim._said_count.get("narrator"))
        self.assertNotEqual(sim._spoke_last, "narrator")


if __name__ == "__main__":
    unittest.main()
