"""Phase 1.2b contract (spec 7.2 row 1.2b, 7.4): who speaks is decided by pressure,
not by rotation. Nobody above THRESHOLD is a legal turn -- a tick of silence.
usage: cd h0/dream && python3 -m unittest test_phase1_pressure -q
"""

import json
import os
import random
import re
import tempfile
import threading
import unittest
from unittest import mock

import sim as sim_mod
from dialogue import (ACTOR_STREAK_MAX, Dialogue, THRESHOLD, TICK, W_ADDRESSED,
                      W_EVENT_HIT, W_GOAL_OPEN, W_SILENT, W_SPOKE_LAST)
from fake import FakeTransport
from sim import Sim, load_profile
from test_phase1_util import manual_clock, pump


def rows(root):
    with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class StubDialogue:
    """Just enough of Dialogue for the loop: every turn is a scripted line.
    No transport, no prompts -- the sim's own choice of speaker is under test."""

    def __init__(self, hero, script=None):
        self.hero = hero
        self.event_sink = None
        self.script = script or (lambda who, role, n: "[flat] line %d." % n)
        self.n = 0

    def _line(self, who, role):
        self.n += 1
        text = self.script(who, role, self.n)
        if text is None:
            return None
        return {"who": who, "role": role, "text": text, "remarks": [], "raw": text}

    def hero_line(self, world, transcript, world_events=()):
        return self._line(self.hero, "hero")

    def actor_line(self, actor, world, transcript, state, notes=(), events=(), persona=""):
        return self._line(actor, "actor")


class PressureTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        sim_mod.use_scene("roof3")
        self.addCleanup(sim_mod.use_scene, "start")

    def _sim(self, dialogue):
        self.root = tempfile.mkdtemp()
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dialogue)
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        manual_clock(self, sim)
        return sim

    def _stub_sim(self, script=None):
        dlg = StubDialogue("Max", script)
        sim = self._sim(dlg)
        self.assertEqual(sim.hero, "Max")
        self.assertEqual(sim.actors, ["Dan", "Maya", "neighbor"])
        return sim, dlg

    def _lines(self, sim, want, max_ticks=400):
        """Pump until `want` lines are spoken (a turn can cost several ticks)."""
        for _ in range(max_ticks):
            said = [r for r in rows(self.root) if r["type"] == "line"]
            if len(said) >= want:
                break
            pump(sim)
        return [r for r in rows(self.root) if r["type"] == "line"][:want]

    # --- the formula itself ---------------------------------------------------
    def test_pressure_formula(self):
        sim, _ = self._stub_sim()
        sim._note_line("Max", "hero", "[flat] Dan, where did you come from?")
        self.assertEqual(sim._pressure("Dan"), {
            "p": 3.0, "addressed": 1, "event_hit": 0, "goal_open": 0,
            "silent": 0, "spoke_last": 0})
        self.assertEqual(sim._pressure("Max"), {
            "p": -2.0, "addressed": 0, "event_hit": 0, "goal_open": 0,
            "silent": 0, "spoke_last": 1})
        # addressed survives two free ticks and no longer
        self.assertEqual(sim._pick_speaker(), ("Dan", "actor"))
        self.assertEqual(sim._pressure("Dan")["addressed"], 1)
        self.assertEqual(sim._pressure("Dan")["p"], 3.5)
        self.assertEqual(sim._pick_speaker(), ("Dan", "actor"))
        self.assertEqual(sim._pressure("Dan")["addressed"], 0)
        self.assertEqual(sim._pressure("Dan")["p"], 1.0)
        # ticks of silence never move spoke_last, and nobody is above the threshold
        self.assertEqual(sim._pick_speaker(), (None, None))
        self.assertEqual(sim._pressure("Max")["spoke_last"], 1)
        self.assertEqual(sim._pressure("Max")["silent"], 3)
        self.assertEqual(sim._pressure("Max")["p"], -0.5)
        log = rows(self.root)
        silence = [r for r in log if r["type"] == "silence"]
        self.assertEqual(len(silence), 1, "a tick nobody won was not logged")
        self.assertIn("Dan", silence[0]["pressure"])
        self.assertTrue([r for r in log if r["type"] == "pressure"],
                        "pressure was never logged on a free tick")

    def test_pressure_logged_on_every_free_tick(self):
        """7.4: `pressure` is written on the tick, also when the table repeats --
        past SILENT_CAP nothing in it moves and it used to go unlogged."""
        sim, _ = self._stub_sim()
        ticks = 12
        for _ in range(ticks):
            sim._pick_speaker()
        logged = [r for r in rows(self.root) if r["type"] == "pressure"]
        self.assertEqual(len(logged), ticks)

    # --- two actor lines in a row block the actors ---------------------------
    def test_two_actor_lines_block_actors(self):
        # everyone calls Dan: without the rule Dan and friends would never stop
        sim, _ = self._stub_sim(
            lambda who, role, n: "[flat] Dan, hold on, number %d." % n)
        said = self._lines(sim, 40)
        self.assertEqual(len(said), 40, "the scene went mute")
        streak = best = 0
        for r in said:
            streak = streak + 1 if r.get("role") == "actor" else 0
            best = max(best, streak)
        self.assertLessEqual(best, ACTOR_STREAK_MAX,
                             "an actor spoke a third time in a row")
        self.assertTrue([r for r in said if r.get("role") == "hero"],
                        "the hero never got the turn back")
        # while blocked the actors' pressure is still counted and written
        log = rows(self.root)
        blocked = []
        for i, r in enumerate(log):
            if r["type"] not in ("pressure", "silence"):
                continue
            table = r["pressure"]
            if any(table[a]["p"] >= THRESHOLD for a in sim.actors):
                nxt = next((x for x in log[i + 1:] if x["type"] == "line"), None)
                if nxt is not None and nxt.get("role") == "hero":
                    blocked.append(r)
        self.assertTrue(blocked, "no tick where a loud actor was passed over")
        # the hero reaches the threshold on silence alone
        self.assertTrue([r for r in log if r["type"] == "silence"],
                        "the hero never had to wait in silence")

    # --- nobody is addressed: the silence cap must not starve one actor --------
    def test_equal_pressure_does_not_starve(self):
        """With no name in any line all three actors saturate at SILENT_CAP and
        their pressure is equal. A tie must not always go to the same name."""
        sim, _ = self._stub_sim(lambda who, role, n: "[flat] Line number %d." % n)
        said = self._lines(sim, 30)
        self.assertEqual(len(said), 30, "the scene went mute")
        for actor in sim.actors:
            spoke = len([r for r in said if r.get("who") == actor])
            self.assertGreaterEqual(spoke, 5, "%s starved on equal pressure" % actor)

    # --- roof3: addressed answers next, three actors, loose rotation ----------
    def test_roof3_rotation(self):
        # a scenario of addressings: everyone names the one who waited longest.
        # The second actor in a row hands the turn back to the hero -- an actor
        # is blocked there anyway (max_actor_streak <= 2), so the scenario does
        # not fight the rule. Naming is self-balancing: whoever the rule starves
        # gets named and, pressure-first (F1), answers next.
        shapes = ["[flat] %s, look at me, take %d.",
                  "[low] %s, listen for a second, take %d.",
                  "[tight] %s, I have to say this, take %d.",
                  "[quiet] %s, come closer, take %d."]
        box = {"i": 0, "sim": None}

        def reply(model, effort, system, messages):
            i, box["i"] = box["i"], box["i"] + 1
            sim = box["sim"]
            m = re.match(r"You are (\S+),", system)
            speaking = m.group(1) if m else sim.hero
            if speaking != sim.hero and sim._actor_streak >= ACTOR_STREAK_MAX - 1:
                target = sim.hero
            else:
                others = [c for c in [sim.hero] + list(sim.actors)
                          if c != speaking]
                ranked = sorted(others,
                                key=lambda c: (sim._silent_ticks.get(c, 0), c))
                # loose rotation: every fourth call names the runner-up instead
                # of the longest-waiting, so the actor-only sequence holds both
                # an A, B, A and an A, B, C triple
                target = ranked[-1] if i % 4 else ranked[-2]
            return shapes[i % len(shapes)] % (target, i)

        transport = FakeTransport(reply=reply)
        dlg = Dialogue(load_profile("A"), transport=transport, rng=random.Random(0))
        dlg.background = False
        sim = self._sim(dlg)
        box["sim"] = sim
        said = self._lines(sim, 40)
        self.assertEqual(len(said), 40, "the scene went mute")

        cast = [sim.hero] + list(sim.actors)
        hits = total = 0
        for cur, nxt in zip(said, said[1:]):
            named = [c for c in cast if c != cur.get("who") and c in cur["text"]]
            if len(named) != 1:
                continue
            total += 1
            hits += nxt.get("who") == named[0]
        self.assertGreaterEqual(hits / max(total, 1), 0.8,
                                "the one named by name did not answer next")
        for actor in sim.actors:
            self.assertGreaterEqual(len([r for r in said if r.get("who") == actor]), 5,
                                    "%s barely spoke" % actor)
        # rotation is not strict: in the actor-only sequence both shapes appear
        seq = [r.get("who") for r in said if r.get("role") == "actor"]
        triples = list(zip(seq, seq[1:], seq[2:]))
        self.assertTrue(any(a == c and a != b for a, b, c in triples), "no A, B, A")
        self.assertTrue(any(len({a, b, c}) == 3 for a, b, c in triples), "no A, B, C")

    # --- a call in flight is not silence -------------------------------------
    def test_no_silence_while_in_flight(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        transport = FakeTransport(reply=lambda *a: "[flat] Dan, it is only me.",
                                  gate=gate)
        dlg = Dialogue(load_profile("A"), transport=transport, rng=random.Random(0))
        dlg.background = False
        sim = self._sim(dlg)
        for _ in range(20):
            pump(sim)
            if transport.entered.is_set():
                break
        self.assertTrue(transport.entered.is_set(), "no call ever started")
        before = len([r for r in rows(self.root) if r["type"] == "silence"])
        for _ in range(7):
            self.now += sim.clock.scale(TICK)
            sim._tick()
            sim._maybe_generate_line()
        after = [r for r in rows(self.root) if r["type"] == "silence"]
        self.assertEqual(len(after), before,
                         "silence was logged while the call was still in flight")
        gate.set()
        if sim._gen_thread is not None:
            sim._gen_thread.join(2)

    # --- the human's line is the hero's line ---------------------------------
    def test_human_counts_as_hero(self):
        sim, _ = self._stub_sim(
            lambda who, role, n: "[flat] Dan, hold on, number %d." % n)
        for _ in range(60):
            pump(sim)
            if sim._actor_streak >= 1 and sim.active_line is None:
                break
        self.assertGreaterEqual(sim._actor_streak, 1, "no actor line to interrupt")
        sim.human_say("Maya, say something.")
        for _ in range(4):
            pump(sim)
            if sim._spoke_last == sim.hero:
                break
        self.assertEqual(sim._spoke_last, sim.hero, "the human line was not the hero's")
        self.assertEqual(sim._actor_streak, 0, "the human line did not reset the streak")
        self.assertEqual(sim._pressure(sim.hero)["spoke_last"], 1)
        self.assertEqual(sim._pressure("Maya")["addressed"], 1,
                         "the human named Maya and she was not addressed")


    # --- formula weights are named constants, not literals (review F3) -------
    def test_pressure_weights_are_constants(self):
        self.assertEqual((W_ADDRESSED, W_EVENT_HIT, W_GOAL_OPEN, W_SILENT,
                          W_SPOKE_LAST), (3, 2, 1, 0.5, -2))
        sim, _ = self._stub_sim()
        sim._note_line("Max", "hero", "[flat] Dan, where did you come from?")
        with mock.patch("sim.W_ADDRESSED", 9):
            self.assertEqual(sim._pressure("Dan")["p"], 9.0,
                             "_pressure did not read dialogue.W_ADDRESSED")
        self.assertEqual(sim._pressure("Dan")["p"], 3.0)

    # --- addressed answers next even when another actor waited longer --------
    def test_addressed_beats_starved(self):
        sim, _ = self._stub_sim()
        sim._silent_ticks = {"neighbor": 6}
        sim._addressed = {"Dan": 2}
        who, _ = sim._pick_speaker()
        self.assertEqual(sim._pressure("Dan")["p"], 3.5)
        self.assertEqual(sim._pressure("neighbor")["p"], 3.0)
        self.assertEqual(who, "Dan",
                         "starved neighbor stole the turn from addressed Dan")

    # --- an event can break the actor-streak block (F4) -----------------------
    def test_event_hit_breaks_actor_streak_block(self):
        sim, _ = self._stub_sim()
        sim._actor_streak = ACTOR_STREAK_MAX
        sim._event_hits = {"Dan": 2}
        sim._addressed = {"Maya": 2}
        who, role = sim._pick_speaker()
        self.assertEqual((who, role), ("Dan", "actor"),
                         "event_hit did not let Dan through the streak block")

    def test_actor_streak_block_holds_without_event_hit(self):
        sim, _ = self._stub_sim()
        sim._actor_streak = ACTOR_STREAK_MAX
        sim._addressed = {"Dan": 2}
        who, role = sim._pick_speaker()
        self.assertEqual((who, role), (None, None),
                         "an addressed actor without event_hit got through the block")

    # --- F10: a plain pressure tie goes to the longer-silent actor, not the hero
    def test_event_hit_tie_goes_to_longer_silent_actor_not_hero(self):
        sim_mod.use_scene("roof")
        sim = self._sim(StubDialogue("Max"))
        self.assertEqual(sim.actors, ["Dan"])
        # 1.4: the roof gives Dan an open goal; this test is about the tie-break,
        # not about goals, so it runs with no goals open
        sim.scene["goals"] = []
        sim._load_goals(emit=False)
        sim._silent_ticks.update({"Dan": 3, "Max": 1})
        sim._event_hits["Dan"] = 1
        sim._addressed["Max"] = 1
        self.assertEqual(sim._pressure("Dan")["p"], sim._pressure("Max")["p"])
        who, _ = sim._pick_speaker()
        self.assertEqual(who, "Dan",
                         "F10: hero won a plain pressure tie against a longer-silent actor")

    # --- 7.2 row 1.3 tie-break: longest-silent, then actors in order, hero last
    def test_tie_break_longest_silent_then_actor_order_hero_last(self):
        from dialogue import SILENT_CAP
        cap = SILENT_CAP
        # all four saturated -> equal p; the one silent longest wins, hero too
        sim, _ = self._stub_sim()
        sim._silent_ticks = {"Dan": cap + 1, "Maya": cap + 5,
                             "neighbor": cap + 2, "Max": cap + 3}
        ps = {n: sim._pressure(n)["p"] for n in sim._cast()}
        self.assertEqual(len(set(ps.values())), 1, ps)
        self.assertEqual(sim._pick_speaker()[0], "Maya",
                         "equal p: the longest-silent did not win")
        sim, _ = self._stub_sim()
        sim._silent_ticks = {"Dan": cap, "Maya": cap, "neighbor": cap, "Max": cap + 9}
        self.assertEqual(sim._pick_speaker(), ("Max", "hero"),
                         "equal p: a longer-silent hero lost to an actor")
        # equal p and equal silence: actors in list order beat spoken-least / name
        sim, _ = self._stub_sim()
        sim._silent_ticks = {"Dan": cap + 2, "Maya": cap, "neighbor": cap + 2,
                             "Max": cap}
        sim._said_count = {"Dan": 5, "neighbor": 0}
        self.assertEqual(sim._pick_speaker()[0], "Dan",
                         "equal p and silence: list order did not decide")
        # equal everything: the hero comes last (roof: Dan opens)
        sim, _ = self._stub_sim()
        sim._silent_ticks = {n: cap for n in sim._cast()}
        sim._said_count = {"Max": 0, "Dan": 3, "Maya": 3, "neighbor": 3}
        self.assertEqual(sim._pick_speaker(), ("Dan", "actor"),
                         "equal p and silence: hero was not last")
        sim_mod.use_scene("roof")
        sim = self._sim(StubDialogue("Max"))
        self.assertEqual(sim.actors, ["Dan"])
        sim._silent_ticks = {"Dan": cap, "Max": cap}
        self.assertEqual(sim._pick_speaker()[0], "Dan",
                         "roof, equal p and silence: the hero spoke before Dan")


if __name__ == "__main__":
    unittest.main()
