"""Phase 1.1 contract (spec 7.2 row 1.1, 7.4): a lock on every line before it
reaches the scene, an action-loop detector shared by the sim and bank.score.
usage: cd h0/dream && python3 -m unittest test_phase1_lock -q
"""

import json
import os
import random
import tempfile
import unittest
from unittest import mock

import bank
from dialogue import (Dialogue, HERO_RULES, count_action_loops, lock_line,
                      loop_items)
from fake import FakeTransport
from sim import Sim, load_profile
from test_phase1_util import manual_clock, pump, start_turn

HERE = os.path.dirname(os.path.abspath(__file__))
ROOF = ["roof edge", "water tower", "roof door", "pigeon coop", "satellite dish",
        "broken lawn chair", "neon sign", "puddle", "fire escape", "rooftop antenna"]
NAMES = ["Max", "Dan", "his sister is Maya"]


class LockLineTest(unittest.TestCase):
    def test_too_many_words(self):
        text = "[flat] " + " ".join("word%d" % i for i in range(26))
        self.assertEqual(lock_line(text, ROOF, NAMES), (None, "len"))
        ok = "[flat] " + " ".join("word%d" % i for i in range(25))
        self.assertEqual(lock_line(ok, ROOF, NAMES), (ok, None))

    def test_remarks_trimmed_to_three(self):
        text = "[flat] One. [pause] Two. [sigh] Three. [gasp] Four."
        self.assertEqual(lock_line(text, ROOF, NAMES),
                         ("[flat] One. [pause] Two. [sigh] Three. Four.", None))

    def test_six_remarks_rejected(self):
        text = "[a] x [b] x [c] x [d] x [e] x [f] x"
        self.assertEqual(lock_line(text, ROOF, NAMES), (None, "remarks"))

    def test_two_objects_rejected(self):
        text = "[flat] Look at the roof door and the water tower."
        self.assertEqual(lock_line(text, ROOF, NAMES), (None, "objects"))
        one = "[flat] Look at the Roof Door, just that."
        self.assertEqual(lock_line(one, ROOF, NAMES), (one, None))

    def test_unknown_name_rejected(self):
        text = "[flat] Then Rachel sent me a photo."
        self.assertEqual(lock_line(text, ROOF, NAMES), (None, "name"))

    def test_known_names_and_sentence_starts_pass(self):
        text = "[sighs] Well, Maya, stop."
        self.assertEqual(lock_line(text, ROOF, NAMES), (text, None))
        text = "[flat] Dan. [pause] Max is fine. Really."
        self.assertEqual(lock_line(text, ROOF, NAMES), (text, None))

    def test_name_stoplist_and_plural(self):
        text = "[flat] I think I'm fine, OK? God, Mom, Dad. On Fridays and in March."
        self.assertEqual(lock_line(text, ROOF, NAMES), (text, None))
        text = "[flat] It was Maya's idea."
        self.assertEqual(lock_line(text, ROOF, NAMES), (text, None))
        text = "[flat] That is Rachel's idea."
        self.assertEqual(lock_line(text, ROOF, NAMES), (None, "name"))


class LoopItemsTest(unittest.TestCase):
    def test_phrase_is_one_item(self):
        self.assertEqual(loop_items("[flat] I hold the roof door shut.", ROOF), {"roof door"})

    def test_first_remark_gives_no_alias(self):
        self.assertEqual(loop_items("[kicks the door] Fine.", ROOF), set())
        self.assertEqual(loop_items("[flat] Fine. [kicks the door]", ROOF), {"roof door", "kicks"})

    def test_alias_resolves_unique_last_word(self):
        self.assertEqual(loop_items("[flat] Fine. [taps the dish]", ROOF), {"satellite dish", "taps"})

    def test_alias_not_unique(self):
        objects = ["roof door", "car door"]
        items = loop_items("[flat] Fine. [slams the door]", objects)
        self.assertNotIn("roof door", items)
        self.assertNotIn("car door", items)
        self.assertEqual(items, {"slams", "door"})

    def test_remark_words_and_stoplist(self):
        items = loop_items("[flat] Fine. [kicks gravel, long sigh]", ROOF)
        self.assertEqual(items, {"kicks", "gravel"})

    def test_object_in_remark_counts(self):
        self.assertEqual(loop_items("[flat] Fine. [grips the fire escape]", ROOF),
                         {"fire escape", "grips"})


def _rows(lines, cut_after=None):
    rows = [{"type": "snapshot", "scene": list(ROOF), "actors": ["Dan"], "hero": "Max"}]
    for i, (who, text) in enumerate(lines):
        rows.append({"type": "line", "who": who, "role": "actor" if who == "Dan" else "hero",
                     "text": text})
        if cut_after is not None and i == cut_after:
            rows.append({"type": "loop_cut", "who": who, "item": "satellite dish"})
    return rows


class ActionLoopsTest(unittest.TestCase):
    def test_action_loops_synthetic(self):
        lines = [("Dan", "[flat] Fine. [taps the satellite dish]"),
                 ("Max", "[quiet] Stop it."),
                 ("Dan", "[flat] No. [kicks the dish]"),
                 ("Max", "[quiet] Please."),
                 ("Dan", "[flat] The satellite dish is all I have."),
                 ("Max", "[quiet] Okay.")]
        self.assertGreaterEqual(count_action_loops(_rows(lines)), 1)
        self.assertEqual(count_action_loops(_rows(lines, cut_after=4)), 0)
        self.assertEqual(bank.score(_rows(lines))["action_loops"],
                         count_action_loops(_rows(lines)))
        s = bank.score(_rows(lines, cut_after=4))
        self.assertEqual((s["action_loops"], s["loop_cuts"]), (0, 1))
        for key in ("lock_rejects", "turn_skips"):
            self.assertEqual(s[key], 0)

    def test_action_loops_r1(self):
        want = {"run_0_978509": 0, "run_0_978510": 0, "run_0_978511": 10, "run_0_978512": 0}
        for name, n in want.items():
            path = os.path.join(HERE, "..", "out", "dream", "bank", name, "log.jsonl")
            if not os.path.exists(path):
                self.skipTest("r1 logs are not on this machine")
            with open(path, encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            got = count_action_loops(rows)
            if n:
                self.assertGreaterEqual(got, n, name)
            else:
                self.assertEqual(got, 0, name)
            self.assertEqual(bank.score(rows)["action_loops"], got, name)


class LockRejectsAllTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))

    def test_lock_rejects_all_two_calls(self):
        root = tempfile.mkdtemp()
        long = "[flat] " + " ".join("w%d" % i for i in range(30))
        t = FakeTransport(reply=lambda *a: long)
        dlg = Dialogue(load_profile("A"), transport=t, rng=random.Random(0))
        dlg.background = False
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=root, dialogue=dlg)
        self.addCleanup(sim.close)
        mock.patch.object(sim.director, "consult_async").start()
        self.addCleanup(mock.patch.stopall)
        manual_clock(self, sim)
        start_turn(self, sim)
        sim._maybe_generate_line()  # pick up the result of the worker
        self.assertEqual(t.calls, 2)
        with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        skips = [r for r in rows if r["type"] == "turn_skip"]
        self.assertEqual(len(skips), 1)
        first = skips[0]["who"]
        self.assertIn(first, [sim.hero] + list(sim.actors))
        rejects = [r for r in rows if r["type"] == "lock_reject"]
        self.assertEqual([r["reason"] for r in rejects], ["len", "len"])
        self.assertEqual(rejects[0]["who"], first)
        # no new generation before clock.scale(4)
        self.now += sim.clock.scale(4) - 0.1
        sim._tick()
        sim._maybe_generate_line()
        self.assertEqual(t.calls, 2)
        self.now += 0.1
        sim._tick()
        sim._maybe_generate_line()
        th = sim._gen_thread
        if th is not None:
            th.join(2)
        sim._maybe_generate_line()
        self.assertEqual(t.calls, 4)
        with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        skips = [r for r in rows if r["type"] == "turn_skip"]
        self.assertEqual(len(skips), 2)
        # the skipped speaker is passed over once
        self.assertNotEqual(skips[1]["who"], first)
        self.assertEqual(bank.score(rows)["turn_skips"], 2)
        self.assertEqual(bank.score(rows)["lock_rejects"], 4)
        # 7.4: diagnostics go to the log only, not to the director's memory
        self.assertFalse([e for e in sim.memory.events if "turn_skip" in e])


class LoopCutInSimTest(unittest.TestCase):
    """Three lines of one actor on one object: loop_cut is logged after the third
    line, the next prompt says the thing is finished, the detector reads 0."""

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.actor_prompts = []
        self.n = 0

    def _reply(self, model, effort, system, messages):
        user = messages[-1]["content"] if messages else ""
        if system.startswith("You are SpongeBob."):
            self.n += 1
            return "[quiet] %s" % ["Nothing yet.", "Still here.", "Hm, okay.", "Fine then.",
                                   "Right.", "Sure.", "Go on.", "Mm."][self.n % 8]
        if system.startswith("You are Squidward"):
            self.actor_prompts.append(user)
            k = len(self.actor_prompts)
            if k <= 3:
                return "[sigh] %s. [taps the clarinet]" % ["Go home", "Not tonight", "Leave it"][k - 1]
            return "[sigh] %s." % ["Enough", "Stop", "Sit", "Quiet"][k % 4]
        return ""

    def test_loop_cut(self):
        root = tempfile.mkdtemp()
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=self._reply),
                       rng=random.Random(0))
        dlg.background = False
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=root, dialogue=dlg)
        self.addCleanup(sim.close)
        mock.patch.object(sim.director, "consult_async").start()
        self.addCleanup(mock.patch.stopall)
        manual_clock(self, sim)
        pump(sim, 60)
        with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        cuts = [r for r in rows if r["type"] == "loop_cut"]
        # the object and the verb of the remark both loop (spec 7в, defect 8)
        self.assertEqual([(c["who"], c["item"]) for c in cuts],
                         [("Squidward", "clarinet"), ("Squidward", "taps")])
        kinds = [r["type"] for r in rows]
        i = kinds.index("loop_cut")
        before = [r for r in rows[:i] if r["type"] == "line" and r["who"] == "Squidward"]
        self.assertEqual(len(before), 3)
        self.assertEqual(count_action_loops(rows), 0)
        self.assertTrue(any("clarinet is finished, leave it" in p for p in self.actor_prompts[3:]))
        # 7.4: loop_cuts = count(loop_cut) -- one per (speaker, item) pair
        self.assertEqual(bank.score(rows)["loop_cuts"], len(cuts))
        self.assertFalse([e for e in sim.memory.events if "loop_cut" in e])


class LockHintTest(unittest.TestCase):
    """Bench 1.1 run_0_836717: 14 of 15 rejects were `len`, Spark Open ignored
    "shorter"; the rules name a number and the retry quotes the count."""

    def test_len_hint_quotes_count_and_rules_name_limit(self):
        from dialogue import ACTOR_RULES, VOICE_RULES, lock_hint
        long = "[flat] " + " ".join("w%d" % i for i in range(30))
        self.assertIn("30 words", lock_hint("len", long))
        self.assertEqual(lock_hint("objects", long), dialogue_hint("objects"))
        self.assertIn("no more than 15 spoken words", VOICE_RULES)
        for rules in (HERO_RULES, ACTOR_RULES):
            self.assertIn("thrown away unheard", rules)


def dialogue_hint(why):
    from dialogue import LOCK_HINTS
    return LOCK_HINTS[why]


class HeroRulesTest(unittest.TestCase):
    def test_hero_rules_rewritten(self):
        self.assertNotIn("brings something new", HERO_RULES)
        self.assertNotIn("pick up something", HERO_RULES)
        self.assertIn("answer, react, claim, want or refuse", HERO_RULES)


class RoofFactTest(unittest.TestCase):
    def test_sister_named(self):
        with open(os.path.join(HERE, "scenes", "roof.json"), encoding="utf-8") as f:
            scene = json.load(f)
        facts = [x["text"] for x in scene["hero"]["soul"]["facts"]]
        self.assertTrue(any("Maya" in t for t in facts))


if __name__ == "__main__":
    unittest.main()


ROOF_WORLD = {"place": "a rooftop", "objects": ROOF, "actors": ["Squidward"]}
TOWER_SAID = [("Squidward", "[sigh] Water tower hums all night."),
              ("Max", "[flat] Yeah."),
              ("Squidward", "[sigh] Someone painted the water tower blue."),
              ("Max", "[flat] Huh.")]


def _tower_dialogue(case, reply="[sigh] That water tower leaks."):
    dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=lambda *a: reply),
                   rng=random.Random(0))
    dlg.background = False
    return dlg


class LoopStateOnAcceptTest(unittest.TestCase):
    """F1: the turn count and the loop cuts of a speaker move only when the line is
    really spoken. A generated line can still be thrown away by the sim (an old
    scene, a human line in between), and a thrown-away line must leave no trace."""

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))

    def test_cuts_recorded_only_on_accept(self):
        dlg = _tower_dialogue(self)
        line = dlg.actor_line("Squidward", ROOF_WORLD, list(TOWER_SAID), {})
        self.assertEqual(line["cuts"], ["water tower"])
        # nothing is remembered yet: the sim has not taken the line
        self.assertEqual(dlg._turns, {})
        self.assertEqual(dlg._cuts, {})
        self.assertEqual(dlg._cut_block("Squidward"), "")
        dlg.accept(line)
        self.assertEqual(dlg._turns.get("Squidward"), 1)
        self.assertIn("water tower", dlg._banned("Squidward"))
        self.assertIn("water tower is finished, leave it", dlg._cut_block("Squidward"))

    def test_discarded_line_adds_no_turn_cut_or_event(self):
        root = tempfile.mkdtemp()
        dlg = _tower_dialogue(self)
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=root, dialogue=dlg)
        self.addCleanup(sim.close)
        mock.patch.object(sim.director, "consult_async").start()
        self.addCleanup(mock.patch.stopall)
        manual_clock(self, sim)
        line = dlg.actor_line("Squidward", ROOF_WORLD, list(TOWER_SAID), {})
        self.assertEqual(line["cuts"], ["water tower"])
        # the human spoke while this line was in flight: the epoch no longer matches
        with sim._gen_lock:
            sim._gen_result = (line, sim.n_transitions, sim._turn_epoch - 1, "Squidward")
        sim._maybe_generate_line()
        self.assertEqual(dlg._turns.get("Squidward", 0), 0)
        self.assertEqual(dlg._cuts.get("Squidward", {}), {})
        with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        self.assertEqual([r for r in rows if r["type"] == "loop_cut"], [])


class BannedObjectLockTest(unittest.TestCase):
    """F2: a cut object is still an object of the scene, so the lock keeps counting
    it; the four-turn ban only takes it out of the prompt."""

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.prompts = []

    def test_banned_object_still_rejects_a_two_object_line(self):
        dlg = _tower_dialogue(self, "[sigh] The roof door and the water tower, both.")
        dlg.event_sink = lambda e: self.prompts.append(e)
        dlg._turns["Squidward"] = 1
        dlg._cuts["Squidward"] = {"roof door": 1}
        self.assertIn("roof door", dlg._banned("Squidward"))
        line = dlg.actor_line("Squidward", ROOF_WORLD, [], {})
        self.assertIsNone(line)
        self.assertEqual([e["reason"] for e in self.prompts], ["objects", "objects"])

    def test_banned_object_leaves_the_hero_prompt(self):
        def reply(model, effort, system, messages):
            self.prompts.append(messages[-1]["content"])
            return "[flat] Fine."
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=reply),
                       rng=random.Random(0))
        dlg.background = False
        dlg._turns[dlg.hero] = 1
        dlg._cuts[dlg.hero] = {"roof door": 1}
        dlg.hero_line(ROOF_WORLD, [])
        around = [p for p in self.prompts if "Around you:" in p]
        self.assertTrue(around)
        self.assertNotIn("roof door", around[0].split("Around you:")[1].split(".")[0])
        self.assertIn("water tower", around[0])
