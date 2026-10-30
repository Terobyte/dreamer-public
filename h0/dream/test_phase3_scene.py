"""Phase 3.1a: a scene up to five actors (spec 7.2 row 3.1a).
usage: cd h0/dream && python3 -m unittest -q test_phase3_scene
Offline: every call goes through FakeTransport, nothing touches the network."""

import json
import os
import tempfile
import unittest
from unittest import mock

import bank
import dialogue as D
import director
import fsm
import sim as S
from dialogue import Dialogue, compact_every
from fake import FakeTransport
from sim import load_profile

HERE = os.path.dirname(os.path.abspath(__file__))
VOICES = ["old_woman", "old_man", "woman", "man", "child", "creature"]
OBJECTS = ["roof edge", "water tower", "roof door", "pigeon coop", "neon sign"]


def _ns(n_actors):
    return {"actors": [{"name": "A%d" % i, "voice": "man", "persona": "someone"}
                       for i in range(n_actors)],
            "objects": list(OBJECTS)}


class CheckScene(unittest.TestCase):
    def test_check_scene_actor_count(self):
        for n in (1, 5):
            self.assertIsNone(fsm.check_scene(_ns(n), VOICES), n)
            self.assertIsNone(fsm.check_target(
                {"bridge": "roof door", "next_scene": _ns(n)}, OBJECTS, VOICES), n)
        for n in (0, 6):
            self.assertEqual(fsm.check_scene(_ns(n), VOICES),
                             ("next_scene", "bad_size"), n)
            self.assertEqual(fsm.check_target(
                {"bridge": "roof door", "next_scene": _ns(n)}, OBJECTS, VOICES),
                ("next_scene", "bad_size"), n)

    def test_check_scene_voice(self):
        ns = _ns(3)
        ns["actors"][2]["voice"] = "robot"
        self.assertEqual(fsm.check_scene(ns, VOICES), ("voice", "voice_not_in_pool"))

    def test_schema_says_five(self):
        self.assertIn('"actors": 1 to 5', director.DIRECTOR_SCHEMA)
        self.assertNotIn("1 or 2", director.DIRECTOR_SCHEMA)


class CompactWindow(unittest.TestCase):
    def test_compact_every_by_cast(self):
        self.assertEqual(D.COMPACT_EVERY, 4)
        self.assertEqual(compact_every(2), 4)
        self.assertEqual(compact_every(3), 8)
        self.assertEqual(compact_every(5), 8)


MEM_REPLY = ("SO FAR: the three of them argued on the roof all night.\n"
             "KNOW: Max lost his job\nPROMISED: none\n"
             "TRIED: [1] Dan: the ledge; [2] Maya: the warehouse")


class SharedMind(unittest.TestCase):
    def _reply(self, model, effort, system, messages):
        if "TRIED:" in system:
            self.compress += 1
            return MEM_REPLY
        return "[quiet] nothing"

    def test_shared_mind_plus_tried(self):
        with open(os.path.join(HERE, "scenes", "roof3.json"), encoding="utf-8") as f:
            scene = json.load(f)
        hero = scene["hero"]["name"]
        cast = [a["name"] for a in scene["actors"]]
        self.compress = 0
        dlg = Dialogue({"hero": hero}, transport=FakeTransport(reply=self._reply))
        dlg.background = False
        says = {cast[0]: "[fast] Not the ledge, Max.",
                cast[1]: "[sharp] Say what happened at the warehouse.",
                cast[2]: "[calm] The pigeons are quiet tonight."}
        for i in range(4):
            for who in cast:
                dlg.heard(who, says[who] + (" %d" % i))
        self.assertEqual(dlg.compact(cast), [D.SCENE_MIND])
        self.assertEqual(self.compress, 1)

        self.assertIn("argued on the roof", dlg.memory_text(cast[0]))
        self.assertEqual(dlg.memory_text(cast[0]), dlg.memory_text(cast[1]))
        a_tried, b_tried = (dlg.mind(cast[0]).tried_text(),
                            dlg.mind(cast[1]).tried_text())
        self.assertNotEqual(a_tried, b_tried)
        self.assertIn("ledge", a_tried)
        self.assertNotIn("warehouse", a_tried)
        self.assertIn("warehouse", b_tried)
        self.assertNotIn("ledge", b_tried)
        self.assertIsNot(dlg.mind(hero), dlg.scene_mind)
        self.assertEqual(dlg.memory_text(hero), "")

    def test_shared_tried_attributed_to_speaker(self):
        # F2: each TRIED item names the folded line it summarises, so a shared
        # word (Dan's paint "not fine enough" / Maya's "are you fine?") cannot
        # carry "asking Max if he is fine" to the wrong one -- it is Maya's because
        # line 2 is hers in the log, not because of word overlap.
        reply = ("SO FAR: the three of them talked past midnight.\n"
                 "KNOW: none\nPROMISED: none\n"
                 "TRIED: [2] Maya: asking Max if he is fine; [3] neighbor: feeding the pigeons")
        def _reply(model, effort, system, messages):
            if "TRIED:" in system:
                return reply
            return "[quiet] nothing"
        with open(os.path.join(HERE, "scenes", "roof3.json"), encoding="utf-8") as f:
            scene = json.load(f)
        hero = scene["hero"]["name"]
        cast = [a["name"] for a in scene["actors"]]
        dlg = Dialogue({"hero": hero}, transport=FakeTransport(reply=_reply))
        dlg.background = False
        says = {cast[0]: "[fast] The paint on my jacket is not fine enough.",
                cast[1]: "[sharp] Max, are you fine?",
                cast[2]: "[calm] The pigeons are quiet tonight."}
        for _ in range(4):
            for who in cast:
                dlg.heard(who, says[who])
        self.assertEqual(dlg.compact(cast), [D.SCENE_MIND])
        maya_tried = dlg.mind(cast[1]).tried_text()
        dan_tried = dlg.mind(cast[0]).tried_text()
        night_tried = dlg.mind(cast[2]).tried_text()
        self.assertIn("asking Max if he is fine", maya_tried)
        self.assertNotIn("asking Max if he is fine", dan_tried)
        self.assertIn("feeding the pigeons", night_tried)
        self.assertNotIn("feeding the pigeons", dan_tried)
        self.assertNotIn("feeding the pigeons", maya_tried)

    def test_shared_tried_not_stolen_by_hearsay(self):
        # F3, F4: Dan's line only reports, in the second person, an action Maya
        # did herself ("you asked") -- any word-overlap heuristic would favour
        # Dan's report, or lose the item entirely once Maya paraphrases it with no
        # shared words at all. The line number sidesteps both: the item is Maya's
        # because line 2 is hers.
        reply = ("SO FAR: the three of them argued about Friday.\n"
                 "KNOW: none\nPROMISED: none\n"
                 "TRIED: [2] Maya: asking Max about the job")
        def _reply(model, effort, system, messages):
            if "TRIED:" in system:
                return reply
            return "[quiet] nothing"
        with open(os.path.join(HERE, "scenes", "roof3.json"), encoding="utf-8") as f:
            scene = json.load(f)
        hero = scene["hero"]["name"]
        cast = [a["name"] for a in scene["actors"]]
        dlg = Dialogue({"hero": hero}, transport=FakeTransport(reply=_reply))
        dlg.background = False
        says = {cast[0]: "[flat] Maya, Max was angry when you asked about the job.",
                cast[1]: "[sharp] I asked Max about the job, but I did not mean it.",
                cast[2]: "[quiet] The roof is cold tonight."}
        for _ in range(4):
            for who in cast:
                dlg.heard(who, says[who])
        self.assertEqual(dlg.compact(cast), [D.SCENE_MIND])
        maya_tried = dlg.mind(cast[1]).tried_text()
        dan_tried = dlg.mind(cast[0]).tried_text()
        self.assertIn("asking Max about the job", maya_tried)
        self.assertNotIn("asking Max about the job", dan_tried)


    def test_shared_tried_survives_paraphrase(self):
        # F4: Maya's own line paraphrases what she did ("I cornered him about the
        # warehouse position") with no words at all in common with the item text
        # ("asking Max about the job") -- no amount of word-overlap tuning can
        # attribute this correctly; the number of the line it summarises can.
        reply = ("SO FAR: the three of them argued about Friday.\n"
                 "KNOW: none\nPROMISED: none\n"
                 "TRIED: [2] Maya: asking Max about the job")
        def _reply(model, effort, system, messages):
            if "TRIED:" in system:
                return reply
            return "[quiet] nothing"
        with open(os.path.join(HERE, "scenes", "roof3.json"), encoding="utf-8") as f:
            scene = json.load(f)
        hero = scene["hero"]["name"]
        cast = [a["name"] for a in scene["actors"]]
        dlg = Dialogue({"hero": hero}, transport=FakeTransport(reply=_reply))
        dlg.background = False
        says = {cast[0]: "[flat] Maya, you asked Max about the job, remember?",
                cast[1]: "[sharp] I cornered him about the warehouse position.",
                cast[2]: "[quiet] The roof is cold tonight."}
        for _ in range(4):
            for who in cast:
                dlg.heard(who, says[who])
        self.assertEqual(dlg.compact(cast), [D.SCENE_MIND])
        self.assertIn("asking Max about the job", dlg.mind(cast[1]).tried_text())
        self.assertNotIn("asking Max about the job", dlg.mind(cast[0]).tried_text())

    def test_shared_tried_survives_second_fold(self):
        # F5: a fold's prompt carries the previous TRIED forward (with its actor),
        # and the item survives the second fold whether or not the reply repeats
        # it -- old items are merged per actor, not replaced by the reply.
        calls = []
        def _reply(model, effort, system, messages):
            if "TRIED:" not in system:
                return "[quiet] nothing"
            calls.append(messages[-1]["content"])
            item = ("[2] Maya: asking Max about the job"
                    if len(calls) == 1 or "asking Max about the job" in calls[-1]
                    else "none")
            return ("SO FAR: the three of them spoke on the roof.\n"
                    "KNOW: none\nPROMISED: none\nTRIED: %s" % item)
        with open(os.path.join(HERE, "scenes", "roof3.json"), encoding="utf-8") as f:
            scene = json.load(f)
        hero = scene["hero"]["name"]
        cast = [a["name"] for a in scene["actors"]]
        dlg = Dialogue({"hero": hero}, transport=FakeTransport(reply=_reply))
        dlg.background = False
        for i in range(12):
            dlg.heard(cast[i % 3], "[flat] first line %d." % i)
        dlg.compact(cast)
        self.assertIn("asking Max about the job", dlg.mind(cast[1]).tried_text())
        for i in range(8):
            dlg.heard(cast[i % 3], "[flat] later line %d." % i)
        dlg.compact(cast)
        self.assertIn("asking Max about the job", calls[1])
        self.assertIn("asking Max about the job", dlg.mind(cast[1]).tried_text())


    def test_shared_tried_same_item_two_actors(self):
        # F8: two actors can bring up the same thing, and the reply then gives the
        # same text for a line of each. One owner per text would let the second
        # overwrite the first (Dan ends up with nothing) -- items are kept per
        # actor, so each of them reads it exactly once.
        reply = ("SO FAR: both of them pushed Max about Friday.\n"
                 "KNOW: none\nPROMISED: none\n"
                 "TRIED: [1] Dan: asking Max about the job; "
                 "[2] Maya: asking Max about the job")
        def _reply(model, effort, system, messages):
            return reply if "TRIED:" in system else "[quiet] nothing"
        with open(os.path.join(HERE, "scenes", "roof3.json"), encoding="utf-8") as f:
            scene = json.load(f)
        hero = scene["hero"]["name"]
        cast = [a["name"] for a in scene["actors"]]
        dlg = Dialogue({"hero": hero}, transport=FakeTransport(reply=_reply))
        dlg.background = False
        for i in range(12):
            dlg.heard(cast[i % 3], "[flat] asking Max about the job %d." % i)
        self.assertEqual(dlg.compact(cast), [D.SCENE_MIND])
        for who in (cast[0], cast[1]):
            tried = dlg.mind(who).tried
            self.assertEqual(tried.count("asking Max about the job"), 1, who)
        self.assertNotIn("asking Max about the job", dlg.mind(cast[2]).tried)

    def test_shared_tried_tag_must_be_a_speaker(self):
        # F7: the tag is the model's claim, not evidence. An item tagged with an
        # actor whose lines are not in the fold at all (the neighbour said
        # nothing), and with no line number to ground it, is nobody's -- `who == a`
        # has to hold against the log.
        reply = ("SO FAR: Dan and Maya argued about Friday.\n"
                 "KNOW: none\nPROMISED: none\n"
                 "TRIED: %s: asking Max about the job")
        with open(os.path.join(HERE, "scenes", "roof3.json"), encoding="utf-8") as f:
            scene = json.load(f)
        hero = scene["hero"]["name"]
        cast = [a["name"] for a in scene["actors"]]
        def _reply(model, effort, system, messages):
            return reply % cast[2] if "TRIED:" in system else "[quiet] nothing"
        dlg = Dialogue({"hero": hero}, transport=FakeTransport(reply=_reply))
        dlg.background = False
        for i in range(12):
            dlg.heard(cast[i % 2], "[flat] line %d about the job." % i)
        self.assertEqual(dlg.compact(cast), [D.SCENE_MIND])
        for who in cast:
            self.assertNotIn("asking Max about the job",
                             dlg.mind(who).tried_text(), who)


class TriedGroundedInOwnLines(unittest.TestCase):
    """F2/F4/F7/F8 repros: an actor's `tried` comes from the folded lines with
    `who == a`. A TRIED item counts only with the number of a folded line, its owner
    is that line's speaker, a name in front of it is a hint that must agree, and a
    line no valid item covers still counts for its own speaker as his words."""

    SAYS = (("Dan", "[flat] Maya, you asked Max about the job, remember?"),
            ("Maya", "[sharp] I cornered him about the warehouse position."),
            ("neighbor", "[quiet] The roof is cold tonight."))

    def _fold(self, tried, says=SAYS, hero_line=None):
        answer = "\n".join(("SO FAR: Maya asked Max about the warehouse job.",
                             "KNOW: none", "PROMISED: none", "TRIED: " + tried))
        self.sent = []
        def reply(model, effort, system, messages):
            if "TRIED:" in system:
                self.sent.append(messages[-1]["content"])
                return answer
            return "[quiet] nothing"
        d = Dialogue({"hero": "Max"}, transport=FakeTransport(reply=reply))
        d.background = False
        for _ in range(4):
            for who, text in says:
                d.heard(who, text)
            if hero_line:
                d.heard("Max", hero_line)
        cast = [w for w, _ in says]
        self.assertEqual(d.compact(cast), [D.SCENE_MIND])
        return d

    def test_untagged_item_keeps_own_line(self):
        # F2/F4/F7 repro: an untagged item points at no line -- it is nobody's,
        # and Maya still has what she said, Dan only what he said.
        d = self._fold("asking Max about the job")
        maya, dan = d.mind("Maya").tried_text(), d.mind("Dan").tried_text()
        self.assertIn("cornered him about the warehouse position", maya)
        self.assertNotIn("asking Max about the job", dan)
        self.assertNotIn("cornered", dan)
        self.assertNotIn("asking Max about the job", maya)
        self.assertNotIn("you asked Max", maya)
        self.assertIn("roof is cold", d.mind("neighbor").tried_text())

    def test_wrong_name_tag_moves_nothing(self):
        # F7 repro: a valid but wrong name, with or without a line number.
        for tried in ("Dan: asking Max about the job",
                      "[2] Dan: asking Max about the job",
                      "[2] neighbor: asking Max about the job"):
            d = self._fold(tried)
            for who in ("Dan", "Maya", "neighbor"):
                self.assertNotIn("asking Max about the job",
                                 d.mind(who).tried_text(), (tried, who))
            self.assertIn("cornered him", d.mind("Maya").tried_text(), tried)
            self.assertNotIn("cornered", d.mind("Dan").tried_text(), tried)

    def test_numbered_item_goes_to_line_speaker(self):
        # line 2 is Maya's: with or without her name the item is hers alone (her
        # lines 5 and 8, which no item covers, still count as her own words)
        for tried in ("[2] asking Max about the job", "2: asking Max about the job",
                      "[2] maya: asking Max about the job"):
            d = self._fold(tried)
            self.assertIn("asking Max about the job", d.mind("Maya").tried_text(), tried)
            self.assertNotIn("asking Max about the job", d.mind("Dan").tried_text(), tried)
            self.assertNotIn("asking Max about the job",
                             d.mind("neighbor").tried_text(), tried)

    def test_same_text_two_actors_keeps_both(self):
        # F8 repro: one text, two owners -- each gets it once, nobody is overwritten
        d = self._fold("[1] Dan: asking Max about the job; [2] Maya: asking Max about the job")
        for who in ("Dan", "Maya"):
            self.assertEqual(d.mind(who).tried.count("asking Max about the job"), 1, who)
        self.assertNotIn("asking Max about the job", d.mind("neighbor").tried)

    def test_out_of_range_and_hero_lines_count_for_no_actor(self):
        # line 99 does not exist; line 4 is the hero's (who folds his own Mind)
        d = self._fold("[99] Maya: asking Max about the job; [4] Max: asking Max about the job",
                       hero_line="[calm] I lost the job, fine.")
        for who in ("Dan", "Maya", "neighbor"):
            self.assertNotIn("asking Max about the job", d.mind(who).tried_text(), who)
            self.assertNotIn("lost the job", d.mind(who).tried_text(), who)

    def test_fold_input_numbers_lines(self):
        d = self._fold("none")
        self.assertIn("[1] Dan: [flat] Maya, you asked Max", self.sent[0])
        self.assertIn("[2] Maya: [sharp] I cornered him", self.sent[0])

    def test_old_items_kept_without_repeat(self):
        # F5: a second fold whose reply says "none" keeps the first fold's items
        d = self._fold("[2] Maya: asking Max about the job")
        for _ in range(3):
            for who, text in self.SAYS[::-1]:
                d.heard(who, "[flat] later %s" % who)
        d.compact(["Dan", "Maya", "neighbor"])
        self.assertEqual(len(self.sent), 2)
        self.assertIn("Maya: asking Max about the job", self.sent[1])
        self.assertIn("asking Max about the job", d.mind("Maya").tried_text())
        self.assertNotIn("asking Max about the job", d.mind("Dan").tried_text())


class NewcomerAfterTransition(unittest.TestCase):
    def _reply(self, model, effort, system, messages):
        if "TRIED:" in system:
            return MEM_REPLY
        return "[quiet] nothing"

    def test_newcomer_gets_no_old_scene_memory(self):
        with open(os.path.join(HERE, "scenes", "roof3.json"), encoding="utf-8") as f:
            scene = json.load(f)
        hero = scene["hero"]["name"]
        cast = [a["name"] for a in scene["actors"]]
        dlg = Dialogue({"hero": hero}, transport=FakeTransport(reply=self._reply))
        dlg.background = False
        for i in range(4):
            for who in cast:
                dlg.heard(who, "[fast] line %d from %s" % (i, who))
        dlg.compact(cast)
        self.assertIn("argued on the roof", dlg.memory_text(cast[0]))
        # transition to a new scene with a fresh cast: mode updates before the
        # first generation, the newcomer must not read the old scene_mind
        dlg.new_scene([hero, "NewA", "NewB", "NewC"])
        self.assertEqual(dlg.n_actors, 3)
        self.assertTrue(dlg.shared)
        self.assertNotIn("argued on the roof", dlg.mind("NewA", seen=2).text())
        self.assertEqual(dlg.mind("NewA", seen=2).text(), "")


class PromptLog(unittest.TestCase):
    def setUp(self):
        self.n = 0
        self.addCleanup(S.use_scene, "start")

    def _reply(self, model, effort, system, messages):
        self.n += 1
        if "TRIED:" in system:
            return MEM_REPLY
        return "[quiet] line number %d of the night." % self.n

    def test_prompt_log_five_actors(self):
        S.use_scene("testdata/five.json")
        root = tempfile.mkdtemp()
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=self._reply))
        dlg.background = False
        sim = S.Sim(profile="A", fake=True, speed=1.0, outdir=root, dialogue=dlg)
        self.addCleanup(sim.close)
        mock.patch.object(sim.director, "consult_async").start()
        self.addCleanup(mock.patch.stopall)
        from test_phase1_util import manual_clock, pump
        manual_clock(self, sim)
        self.assertEqual(len(sim.actors), 5)
        pump(sim, 40)
        with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        prompts = [r for r in rows if r["type"] == "prompt"]
        self.assertTrue(prompts)
        spoke = {r.get("who") for r in rows if r["type"] == "line"}
        self.assertTrue(spoke)
        self.assertTrue(spoke <= {r.get("who") for r in prompts})
        self.assertTrue(all("t" in r for r in prompts))
        top = max(r["tokens"] for r in prompts)
        self.assertLessEqual(top, 5800)
        self.assertEqual(bank.score(rows)["max_prompt_tokens"], top)


if __name__ == "__main__":
    unittest.main()
