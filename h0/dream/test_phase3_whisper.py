"""Phase 3.1b: a whisper to one of the cast, and a director note to several actors
(spec 7.2 row 3.1b).
usage: cd h0/dream && python3 -m unittest -q test_phase3_whisper
Offline: every call goes through FakeTransport, nothing touches the network."""

import os
import tempfile
import unittest
from unittest import mock

import dialogue as D
import fsm
import sim as S
from dialogue import Dialogue
from fake import FakeTransport
from sim import load_profile
from test_phase1_util import manual_clock, pump

HERE = os.path.dirname(os.path.abspath(__file__))
MEM_REPLY = ("SO FAR: the three of them argued on the roof all night.\n"
             "KNOW: Max lost his job\nPROMISED: none\n"
             "TRIED: [1] Dan: the ledge; [2] Maya: the warehouse")
# every filler line is its own sentence: the repeat check throws away a line that
# looks like the one before, and a thrown line costs the speaker his turn
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


class WhisperBase(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        S.use_scene("roof3")
        self.addCleanup(S.use_scene, "start")
        self.whisper = None
        self.said = 0

    def _reply(self, model, effort, system, messages):
        user = messages[0]["content"]
        if "TRIED:" in system:
            return MEM_REPLY
        if self.whisper and "Your line, Dan:" in user:
            raw, self.whisper = self.whisper, None
            return raw
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
        self.assertEqual(sim.actors, ["Dan", "Maya", "neighbor"])
        return sim

    def _prompts(self, who):
        tag = "Your line, %s:" % who
        return [s for s in self.ft.sent if tag in s["messages"][0]["content"]]

    def _text(self, sent):
        return sent["system"] + "\n" + sent["messages"][0]["content"]

    def _pump_until(self, sim, cond, ticks=2000):
        for _ in range(ticks):
            if cond():
                return True
            pump(sim)
        return cond()

    def _actor_line(self, raw, actor="Dan"):
        """One actor_line call with a scripted reply, no sim around it."""
        ft = FakeTransport(reply=lambda m, e, s, msgs: (
            MEM_REPLY if "TRIED:" in s else raw))
        dlg = Dialogue(load_profile("A"), transport=ft)
        dlg.background = False
        world = {"place": "a flat city rooftop at night",
                 "objects": ["roof edge", "pigeon coop", "roof door"],
                 "actors": ["Dan", "Maya", "neighbor"]}
        return dlg.actor_line(actor, world, [], {"build_pct": 0, "bridge": None})


class Whisper(WhisperBase):
    def test_whisper_only_addressee(self):
        sim = self._sim()
        self.whisper = "[low] [[whisper Maya]] it's me"
        self.assertTrue(self._pump_until(sim, lambda: self._prompts("Maya")),
                        "Maya never got a turn")
        self.assertTrue(any("it's me" in self._text(s) for s in self._prompts("Maya")))
        for who in ("neighbor", "Max"):
            self.assertTrue(self._pump_until(sim, lambda w=who: self._prompts(w)),
                            "%s never got a turn" % who)
            for sent in self._prompts(who):
                self.assertNotIn("it's me", self._text(sent), who)
        self.assertIn(("Dan", "[Dan whispers to Maya]"), list(sim.transcript))
        for _, text in sim.transcript:
            self.assertNotIn("it's me", text)

    def test_whisper_to_hero(self):
        sim = self._sim()
        self.whisper = "[low] [[whisper Max]] look up"
        self.assertTrue(self._pump_until(sim, lambda: self._prompts("Max")),
                        "the hero never got a turn")
        self.assertTrue(self._pump_until(
            sim, lambda: any("look up" in self._text(s) for s in self._prompts("Max"))),
            "the whisper never reached the hero")
        for who in ("Maya", "neighbor"):
            self.assertTrue(self._pump_until(sim, lambda w=who: self._prompts(w)),
                            "%s never got a turn" % who)
            for sent in self._prompts(who):
                self.assertNotIn("look up", self._text(sent), who)

    def test_whisper_unknown_addressee(self):
        line = self._actor_line("[low] [[whisper Nobody]] it's me")
        self.assertIsNotNone(line)
        self.assertIsNone(line.get("whisper_to"))
        self.assertIn("it's me", line["text"])
        self.assertNotIn("whisper", line["text"].lower())

    def test_voice_whisper_untouched(self):
        line = self._actor_line("[low] <whisper>quiet</whisper> now, listen")
        self.assertIsNotNone(line)
        self.assertIsNone(line.get("whisper_to"))
        self.assertIn("<whisper>quiet</whisper>", line["text"])

    def test_whisper_not_in_shared_mind(self):
        sim = self._sim()
        self.whisper = "[low] [[whisper Maya]] it's me"
        compress = lambda: [s for s in self.ft.sent if "TRIED:" in s["system"]]
        self.assertTrue(self._pump_until(sim, lambda: bool(compress())),
                        "the shared memory was never folded")
        for sent in compress():
            self.assertNotIn("it's me", self._text(sent))
            self.assertIn("[Dan whispers to Maya]", self._text(sent))

    def test_whisper_not_in_lock_words(self):
        # twenty-five spoken words plus the tag: the tag is no word of the line
        words = ("i have to tell you something about that night before anyone else says it "
                 "and i can not keep it any longer my old friend")
        self.assertEqual(len(words.split()), D.LOCK_MAX_WORDS)
        line = self._actor_line("[low] [[whisper Maya]] " + words)
        self.assertIsNotNone(line, "the tag was counted in the lock")
        self.assertEqual(line["whisper_to"], "Maya")
        self.assertEqual(line["remarks"], ["low"])
        # five single-bracket remarks plus the tag: the tag is no remark either,
        # so the line passes the remark limit, trimmed to the first three
        line2 = self._actor_line("[a] [b] [c] [d] [e] [[whisper Maya]] hello there friend")
        self.assertIsNotNone(line2, "the tag was counted in the remark limit")
        self.assertEqual(line2["whisper_to"], "Maya")
        self.assertEqual(line2["remarks"], ["a", "b", "c"])

    def test_whisper_does_not_address_bystander(self):
        sim = self._sim()
        sim._start_line({"who": "Dan", "role": "actor", "owner": "npc",
                         "text": "Max, look out, the ledge is loose",
                         "whisper_to": "Maya", "remarks": []})
        self.assertEqual(sim._pressure("Max")["addressed"], 0,
                         "a whisper to Maya must not address Max")
        self.assertNotIn("Max", sim._addressed)


class DirectorNotes(WhisperBase):
    def test_note_to_two_actors(self):
        sim = self._sim()
        self.assertIsNone(fsm.check_messages(
            {"messages": [{"to": ["Dan", "Maya"], "note": "n"}]}, sim.actors))
        ev = sim.fsm._deliver_messages(
            0.0, {"messages": [{"to": ["Dan", "Maya"], "note": "n"}]})
        for e in ev:
            sim._emit(e)
        self.assertEqual(sim._notes, {"Dan": ["n"], "Maya": ["n"]})
        for bad in (["Dan", "Max"], ["Dan", "Nobody"]):
            self.assertEqual(fsm.check_messages(
                {"messages": [{"to": bad, "note": "n"}]}, sim.actors),
                ("messages", "unknown_recipient"), bad)

    def test_schema_allows_a_list(self):
        for schema in (__import__("director").DIRECTOR_SCHEMA,
                       __import__("director").LOCKED_SCHEMA):
            self.assertIn("list", schema.split("\"messages\"")[1][:160])


if __name__ == "__main__":
    unittest.main()
