"""Book -> freestyle (go_freestyle, POST /freestyle): the score stops at the next beat
and the same cast improvises on from the same moment through Dialogue.
usage: cd h0/dream && python3 -m unittest -q test_freestyle
"""
import json
import os
import random
import tempfile
import unittest
from unittest import mock

import sim as S
from dialogue import Dialogue
from fake import FakeTransport
from test_phase1_util import manual_clock

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK = os.path.join(HERE, "books", "gwtw")
SQUID = os.path.join(HERE, "..", "squid_live", "book")  # test-only, never ships
REPLY = "[warm] Let us talk about something else entirely."


def rows(root):
    with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class FreestyleTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))

    def tearDown(self):
        S.use_scene("start")  # book runs replace the module-level opening scene

    def _sim(self):
        self.root = tempfile.mkdtemp()
        plan = S._load_book_plan(BOOK, ["library"])
        S.use_scene(plan["scenes"][0]["dict"])
        sim = S.Sim(profile=None, fake=True, speed=1.0, outdir=self.root, book=plan, script=[])
        self.addCleanup(sim.close)
        self.consults = self.enterContext(mock.patch.object(sim.director, "consult_async"))
        manual_clock(self, sim)
        return sim

    def _dialogue(self):
        dlg = Dialogue(S.load_profile(None), transport=FakeTransport(reply=lambda *a: REPLY),
                       rng=random.Random(0))
        dlg.background = False
        return dlg

    def _pump(self, sim, until, steps=400):
        for _ in range(steps):
            if until():
                return
            self.now += 0.5
            sim._tick()
            if sim.book is None:
                sim._maybe_generate_line()
                th = sim._gen_thread
                if th is not None and th.is_alive():
                    th.join(2)
        self.fail("condition never reached")

    def test_switch_mid_scene_stops_the_score_and_improvises(self):
        sim = self._sim()
        self.assertEqual(sim.status()["mode"], "book")
        self._pump(sim, lambda: sim.book["cursor"] >= 3)
        at = sim.book["cursor"]
        left = [b for b in sim.book["beats"][at:] if b["kind"] == "narration"]
        sim.go_freestyle(dialogue=self._dialogue())
        self.assertIsNone(sim.book)
        self.assertEqual(sim.status()["mode"], "free")
        self._pump(sim, lambda: any(r["type"] == "line" and "something else" in r.get("text", "")
                                    for r in rows(self.root)))
        log = rows(self.root)
        mode = [r for r in log if r["type"] == "mode"]
        self.assertEqual(len(mode), 1)
        self.assertEqual((mode[0]["mode"], mode[0]["scene"], mode[0]["at_beat"]),
                         ("freestyle", "library", at))
        # what the book still had to tell is the story they head toward
        self.assertTrue(left and left[0]["text"].split()[0] in mode[0]["story"])
        # nothing of the score is played after the switch
        after = log[log.index(mode[0]):]
        self.assertFalse([r for r in after if r.get("source") == "book"])
        self.assertFalse([r for r in after if r["type"] == "narrator" and r.get("cause") == "book"])
        # the director hears about it once, with the mode row
        self.assertEqual(self.consults.call_args_list[0].kwargs["events"][0]["type"], "mode")

    def test_the_book_is_dealt_out_piece_by_piece(self):
        sim = self._sim()
        sim.go_freestyle(dialogue=self._dialogue())
        pieces = [e for e in sim._schedule if e["kind"] == "story"]
        self.assertGreater(len(pieces), 1)
        # like a loading bar: one piece now, the next ones later, never all at once
        sim._fire_due_events()
        self.assertEqual(sim._hero_world.count(pieces[0]["what"]), 1)
        self.assertNotIn(pieces[1]["what"], sim._hero_world)
        for a in [a for a in sim.actors if a != sim.hero]:
            self.assertIn(pieces[0]["what"], sim._pending[a])
        self.now += sim.FREE_PIECE_SECONDS
        sim._fire_due_events()
        # its time has come, but nobody has played the first piece yet: the bar waits
        self.assertNotIn(pieces[1]["what"], sim._hero_world)
        sim._free_lines = sim.FREE_PIECE_LINES
        sim._fire_due_events()
        self.assertIn(pieces[1]["what"], sim._hero_world)
        # the director hears each piece at its next consult, it is not pulled by it
        stories = [e for e in sim.director.pending if e.get("type") == "story"]
        self.assertEqual(len(stories), 2)
        self.assertIn(pieces[1]["what"], stories[1]["value"])
        self.assertFalse([c for c in self.consults.call_args_list
                          if c.kwargs.get("events") and c.kwargs["events"][0]["type"] == "story"])
        self.consults.reset_mock()
        sim.fsm.idle_since = self.now - 1000  # no nudge or force here: only the idle rhythm
        sim.fsm.nudge_fired = sim.fsm.force_fired = True
        sim._maybe_consult(-1e9)
        self.consults.assert_not_called()
        self.assertNotIn(pieces[2]["what"] if len(pieces) > 2 else "-", sim._hero_world)
        # a piece is what the narrator says there, and roughly what is said
        self.assertIn("In the book it goes roughly", "".join(p["what"] for p in pieces))

    def _squid(self):
        self.root = tempfile.mkdtemp()
        plan = S._load_book_plan(SQUID, ["squid_house", "conch_street"],
                                 os.path.join(SQUID, "score.json"))
        S.use_scene(plan["scenes"][0]["dict"])
        sim = S.Sim(profile=None, fake=True, speed=1.0, outdir=self.root, book=plan, script=[])
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        manual_clock(self, sim)
        return sim

    def test_told_scene_opens_its_door_and_leads_to_the_next_book_scene(self):
        sim = self._squid()
        sim.go_freestyle(dialogue=self._dialogue())
        self.assertEqual(sim._max_transitions, sim.n_transitions + 2)  # the street, then one free dream
        exit_i = next(i for i, e in enumerate(sim._schedule) if e["kind"] == "exit")
        self.now = sim._schedule[exit_i]["t"] + 0.1
        while exit_i not in sim._fired:  # the players play every piece in turn
            sim._free_lines = sim.FREE_PIECE_LINES
            sim._tick()
        # the book's places are already built: the door opens on the same tick
        self.assertEqual(sim.fsm.state, "ready")
        self.assertIn("door", sim.fsm.bridge)
        # nobody walks through: the story carries them out after FREE_DOOR_SECONDS
        self.now += sim.FREE_DOOR_SECONDS + 0.1
        sim._tick()
        self.assertEqual(sim.n_transitions, 1)
        self.assertTrue(sim.place.startswith("Conch Street"))
        self.assertEqual(sim._actor_voices["Squidward"], "man")
        street = [e for e in sim._schedule if e["kind"] == "story"]
        self.assertTrue(street and street[0]["t"] == 0.0)
        self.assertFalse([e for e in sim._schedule if e["kind"] == "exit"])  # the last book scene

    def test_a_director_door_also_leads_to_the_book_scene(self):
        sim = self._squid()
        sim.go_freestyle(dialogue=self._dialogue())
        for e in sim.fsm.start_build(self.now, "front door", "somewhere the director made up"):
            sim._emit(e)
        sim.fsm.build_start = self.now - sim.fsm.p["build"]
        sim._tick()
        self.assertEqual(sim.fsm.state, "ready")
        # an open door does not cut the scene short: nobody is carried out while
        # the book still has pieces for this room
        self.now += sim.FREE_DOOR_SECONDS + 1
        sim._tick()
        self.assertEqual(sim.n_transitions, 0)
        for e in sim.fsm.touch(self.now, "front door"):
            sim._emit(e)
        sim._apply_transition()
        self.assertTrue(sim.place.startswith("Conch Street"))
        self.assertEqual(sim._free_book, [])

    def test_inbox_switches_and_a_second_press_is_ignored(self):
        sim = self._sim()
        sim.dialogue = self._dialogue()
        sim.submit("freestyle")
        sim._tick()
        self.assertIsNone(sim.book)
        sim.submit("freestyle")
        sim._tick()
        log = rows(self.root)
        self.assertEqual(len([r for r in log if r["type"] == "mode"]), 1)
        self.assertTrue([r for r in log if r["type"] == "input" and r.get("source") == "freestyle"
                         and r.get("ignored") == "not a book"])

    def test_without_a_dialogue_one_is_built_and_one_transition_ends_it(self):
        sim = self._sim()
        sim.go_freestyle()
        self.assertIsInstance(sim.dialogue, Dialogue)
        self.assertEqual(sim._max_transitions, sim.n_transitions + 1)
        self.assertEqual(sim.fsm.objects, list(sim.scene["objects"]))


if __name__ == "__main__":
    unittest.main()
