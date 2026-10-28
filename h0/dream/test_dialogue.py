"""Offline tests for live hero/actor lines (spec 4-6, 5a; door as a world fact).
usage: cd h0/dream && python3 -m unittest test_dialogue -q
"""

import json
import os
import tempfile
import unittest

from dialogue import Dialogue, soul_text
from fake import FakeTransport
from sim import START_SCENE, Sim, load_profile

WORLD = {"place": "Squidward's living room", "objects": list(START_SCENE["objects"]),
         "actors": ["Squidward"]}


class PromptTest(unittest.TestCase):
    def test_hero_lives_by_soul_but_not_hidden_facts(self):
        prof = load_profile("A")
        soul = soul_text(prof)
        self.assertIn("Mr. Krabs", soul)
        self.assertIn("quiet", soul)
        self.assertNotIn("fog", soul, "past dream is the director's, not the hero's (spec 12)")
        self.assertNotIn("goes silent", soul)

    def test_no_ladder_left_in_dialogue(self):
        # design doc 2026-10-28, 7.1: no L0-L4 stage lines, no stall lines
        import dialogue
        for gone in ("stage_line", "LADDER_LINES", "STALL_LINES"):
            self.assertFalse(hasattr(dialogue, gone), gone)


class DirectorSoulTest(unittest.TestCase):
    def test_live_director_prompt_carries_the_soul(self):
        """Regression: the sim used to start the director with an empty core
        (desire/anxiety blank, no diary, no past dream) -- bridges were blind."""
        prof = load_profile("A")
        with Sim(profile="A", fake=True, speed=1000.0) as sim:
            text, _ = sim.memory.build_prompt({})
        self.assertIn("desire: quiet", text)
        self.assertIn("being shouted at again tomorrow", text)
        self.assertIn("Mr. Krabs yelled", text)
        self.assertIn(prof["past_dream"], text)
        self.assertIn("goes silent when someone raises", text)


class LockedDirectorNotesTest(unittest.TestCase):
    def test_live_director_is_asked_for_notes_during_build(self):
        """Spec 4: in building the director still sends notes -- a live consult
        must reach Wonder with the notes-only schema, and the note is delivered."""
        from unittest.mock import patch
        from clock import Clock
        from director import Director, LOCKED_SCHEMA
        from fsm import BuildFSM
        clock = Clock(speed=1000.0)
        fsm = BuildFSM(["clarinet"], voices={"man"}, speed=1000.0, now=clock.now(),
                       actors=["Squidward"])
        fsm.start_build(clock.now(), "clarinet", "porch")
        calls = []

        class R:
            text = ('{"messages": [{"to": "Squidward", "note": "hum a lullaby"}], '
                    '"bridge": "clarinet"}')

        def fake_call(role, system, messages, max_tokens=300, **kw):
            calls.append(messages[0]["content"])
            return R()
        with patch("director.llm_call", fake_call):
            d = Director(fsm, actors=["Squidward"], fake=False, clock=clock)
            d.consult_async(clock.now())
            d.wait(2)
        self.assertEqual(len(calls), 1)
        self.assertIn(LOCKED_SCHEMA, calls[0])
        evs = d.drain_events()
        self.assertTrue(any(e["type"] == "message" and e["note"] == "hum a lullaby" for e in evs))
        self.assertTrue(any(e["type"] == "invalid" and e.get("reason") == "target_locked"
                            for e in evs), "a locked target field is logged as invalid")
        self.assertEqual(fsm.bridge, "clarinet")
        # the next consult sees the note it already gave, so it does not rephrase it
        with patch("director.llm_call", fake_call):
            d.consult_async(clock.now())
            d.wait(2)
        self.assertIn("NOTES ALREADY GIVEN THIS SCENE", calls[1])
        self.assertIn("hum a lullaby", calls[1])


class HeroLineTest(unittest.TestCase):
    def test_touch_tag_resolves_to_scene_object_and_is_not_voiced(self):
        t = FakeTransport(["SpongeBob: [whispers] That sounds like grandma... [[TOUCH:the radio]]"])
        line = Dialogue(load_profile("A"), transport=t).hero_line(WORLD, [("Squidward", "Go home.")])
        self.assertEqual(line["touch"], "old radio")
        self.assertEqual(line["text"], "[whispers] That sounds like grandma...")
        self.assertEqual(line["remarks"], ["whispers"])
        sent = t.sent[0]
        self.assertEqual(sent["model"], "meta-models/muse-spark-open-1026")
        self.assertGreaterEqual(sent["max_tokens"], 1500)
        user = sent["messages"][0]["content"]
        self.assertIn("You are in Squidward's living room", user)
        prompt = (sent["system"] + user).lower()
        for word in ("dream", "[world", "impulse", "scene", "bridge", "director"):
            self.assertNotIn(word, prompt, word)
        self.assertIn("Squidward: Go home.", user)

    def test_touch_is_rare(self):
        t = FakeTransport(["[a] Ooh! [[TOUCH:clarinet]]", "[b] Wow! [[TOUCH:radio]]",
                           "[c] Hm. [[TOUCH:radio]]", "[d] Hey. [[TOUCH:radio]]",
                           "[e] Look! [[TOUCH:suitcase]]"])
        d = Dialogue(load_profile("A"), transport=t)
        touches = [d.hero_line(WORLD, [])["touch"] for _ in range(5)]
        self.assertEqual(touches, ["clarinet", None, None, None, "suitcase"])

    def test_counsellor_voice_is_asked_again_then_dropped(self):
        t = FakeTransport(["It's understandable to feel hurt. It was not your fault.",
                           "[shivering] Dan? Why are you soaked?"])
        line = Dialogue(load_profile("A"), transport=t).hero_line(WORLD, [])
        self.assertEqual(line["text"], "[shivering] Dan? Why are you soaked?")
        self.assertIn("starting with [direction]", t.sent[1]["messages"][0]["content"])
        t = FakeTransport(["You are not bad at your job.", "Remember to breathe."])
        self.assertIsNone(Dialogue({}, transport=t).hero_line(WORLD, []))

    def test_empty_reply_gives_none(self):
        self.assertIsNone(Dialogue({}, transport=FakeTransport([""])).hero_line(WORLD, []))


class RepeatTest(unittest.TestCase):
    def test_repeated_hero_line_is_asked_again(self):
        t = FakeTransport(["[softly] Can we just stay quiet here a little longer?",
                           "[gasps] Look -- the radio is humming grandma's song!"])
        tr = [("SpongeBob", "[whispers] Can we just stay quiet here a little longer, please?")]
        line = Dialogue(load_profile("A"), transport=t).hero_line(WORLD, tr)
        self.assertEqual(t.calls, 2)
        self.assertIn("radio", line["text"])
        self.assertIn("You already said", t.sent[0]["messages"][0]["content"])

    def test_director_schema_forbids_quiet_notes(self):
        from director import DIRECTOR_SCHEMA, LOCKED_SCHEMA
        for schema in (DIRECTOR_SCHEMA, LOCKED_SCHEMA):
            self.assertIn("Never ask an actor to calm", schema)


class ImpulseTest(unittest.TestCase):
    def test_impulse_reaches_prompt_and_line(self):
        import random as _r
        from dialogue import HERO_IMPULSES

        class Always(_r.Random):
            def random(self):
                return 0.0
        # 1.1: the lock refuses a name the hero does not know; Squidward is in WORLD
        t = FakeTransport(["[squints] Ha! You're not Squidward."])
        line = Dialogue(load_profile("A"), transport=t, rng=Always(1)).hero_line(WORLD, [])
        self.assertIn(line["impulse"], HERO_IMPULSES)
        self.assertIn("Right now, out of nowhere, %s." % line["impulse"],
                      t.sent[0]["messages"][0]["content"])

    def test_actor_never_gets_an_impulse(self):
        import random as _r

        class Always(_r.Random):
            def random(self):
                return 0.0
        t = FakeTransport(["Get away from the edge!"])
        Dialogue({}, transport=t, rng=Always(1)).actor_line(
            "Dan", WORLD, [], {"build_pct": 0, "bridge": None})
        self.assertNotIn("out of nowhere", t.sent[0]["messages"][0]["content"])
        from llm import ROLE_TEMPERATURE
        self.assertNotIn("actor", ROLE_TEMPERATURE)

    def test_no_impulse_when_dice_say_no(self):
        import random as _r

        class Never(_r.Random):
            def random(self):
                return 0.99
        t = FakeTransport(["[waves] Hi."])
        line = Dialogue({}, transport=t, rng=Never(1)).hero_line(WORLD, [])
        self.assertIsNone(line["impulse"])
        self.assertNotIn("out of nowhere", t.sent[0]["messages"][0]["content"])


class VoiceDirectionTest(unittest.TestCase):
    def test_rules_ask_for_heard_voice_not_body(self):
        from dialogue import ACTOR_RULES, HERO_RULES
        for rules in (HERO_RULES, ACTOR_RULES):
            self.assertIn("never what your hands or eyes do", rules)
            self.assertIn("<emphasis>", rules)
            self.assertNotIn("hero", rules.replace("hands", ""))

    def test_drama3_word_tags_reach_the_voice_other_angles_do_not(self):
        t = FakeTransport(["[scared] Max, <emphasis>please</emphasis> <b>come</b> here."])
        import random as _r

        class Never(_r.Random):
            def random(self):
                return 1.0
        line = Dialogue(load_profile("A"), transport=t, rng=Never(1)).hero_line(WORLD, [])
        self.assertIn("<emphasis>please</emphasis>", line["text"])
        self.assertNotIn("<b>", line["text"])

    def test_tts_model_is_drama3(self):
        import voice
        self.assertEqual(voice.MODEL, "drama-3")


class RunningBitTest(unittest.TestCase):
    """Roof run: Dan said "that's one... lost it" ~8 times, each line otherwise new,
    so line overlap never fired. A phrase in two own lines is now a used-up bit."""

    def test_bit_is_named_up_front_and_a_reuse_is_caught(self):
        import dialogue as dl
        own = ["[x] Okay, that's one... lost it. Wait.",
               "[y] Look, the dish! That's one, lost it again."]
        self.assertIn("that's one lost", dl.running_bits(own))
        self.assertTrue(dl.uses_bit("[a] fine fine, that's one lost it", own))
        self.assertFalse(dl.uses_bit("[a] tell me about Friday", own))
        block = dl._no_repeat_block([("Dan", t) for t in own], "Dan")
        self.assertIn("running bit is used up", block)
        self.assertEqual(dl.running_bits(["[a] one line only, that's one lost"]), [])

    def test_square_bracket_word_tag_becomes_angle(self):
        import dialogue as dl
        out = dl._clean_spoken("[soft] [whisper]keep[/whisper] it or not", "actor")
        self.assertEqual(out, "[soft] <whisper>keep</whisper> it or not")
        self.assertEqual(dl._clean_spoken("[whisper] come here", "actor"), "[whisper] come here")


class QuestionRunTest(unittest.TestCase):
    """Bank r2: 127 of 132 hero lines held a question. Two in a row -> the next
    prompt asks for none, and a line that still asks is asked again once."""

    def _never(self):
        import random as _r

        class Never(_r.Random):
            def random(self):
                return 0.99
        return Never(1)

    def test_two_questions_in_a_row_ask_for_a_line_without(self):
        tr = [("Max", "[x] What is that light?"), ("Vik", "[y] Nothing."),
              ("Max", "[x] Why is the clock backwards?"), ("Vik", "[y] Sleep.")]
        t = FakeTransport(["[tired] Why won't you look at me?", "[flat] I'm not sleeping."])
        line = Dialogue({"hero": "Max"}, transport=t, rng=self._never()).hero_line(WORLD, tr)
        self.assertIn("this time ask nothing", t.sent[0]["messages"][0]["content"])
        self.assertEqual(t.calls, 2)
        self.assertEqual(line["text"], "[flat] I'm not sleeping.")

    def test_one_question_leaves_the_prompt_alone(self):
        tr = [("Max", "[x] I hate this place."), ("Vik", "[y] Nothing."),
              ("Max", "[x] Why is the clock backwards?")]
        t = FakeTransport(["[tired] Why?"])
        Dialogue({"hero": "Max"}, transport=t, rng=self._never()).hero_line(WORLD, tr)
        self.assertNotIn("ask nothing", t.sent[0]["messages"][0]["content"])
        self.assertEqual(t.calls, 1)


class OpenDoorTest(unittest.TestCase):
    """Design doc 2026-10-28, 7.1: the open door reaches the hero as a world event
    ("has swung open"), there is no `pull`, and TOUCH_EVERY holds for the door too."""

    def test_open_door_is_a_world_event_and_the_gate_holds(self):
        obj = WORLD["objects"][0]
        opened = ["the %s has swung open" % obj]
        t = FakeTransport(["[x] Fine, I'm going. [[TOUCH:%s]]" % obj] * 2)
        d = Dialogue({"hero": "Max"}, transport=t, rng=QuestionRunTest()._never())
        line = d.hero_line(WORLD, [], opened)
        prompt = t.sent[0]["messages"][0]["content"]
        self.assertIn("has swung open", prompt)
        self.assertNotIn("open for you", prompt)
        self.assertEqual(line["touch"], obj, "first touch of the night passes the gate")
        t2 = FakeTransport(["[x] Again. [[TOUCH:%s]]" % obj] * 2)
        d2 = Dialogue({"hero": "Max"}, transport=t2, rng=QuestionRunTest()._never())
        d2._last_touch = d2._hero_turns  # a touch just happened: the gate is shut
        self.assertIsNone(d2.hero_line(WORLD, [], opened)["touch"],
                          "the door is no exception to TOUCH_EVERY")
        t3 = FakeTransport(["[x] Hi."])
        Dialogue({"hero": "Max"}, transport=t3).hero_line(WORLD, [])
        self.assertNotIn("swung open", t3.sent[0]["messages"][0]["content"])

    def test_other_objects_keep_the_gate(self):
        """The gate is general, not door-only: a touch of any object right after
        another one is dropped, so the open door is the exception-free case above."""
        other = WORLD["objects"][1]
        t = FakeTransport(["[x] I grab it. [[TOUCH:%s]]" % other] * 2)
        d = Dialogue({"hero": "Max"}, transport=t, rng=QuestionRunTest()._never())
        d._last_touch = d._hero_turns  # a touch just happened
        self.assertIsNone(d.hero_line(WORLD, [])["touch"],
                          "a non-bridge object is gated by TOUCH_EVERY too")
        t2 = FakeTransport(["[x] I grab it. [[TOUCH:%s]]" % other] * 2)
        d2 = Dialogue({"hero": "Max"}, transport=t2, rng=QuestionRunTest()._never())
        self.assertEqual(d2.hero_line(WORLD, [])["touch"], other)


class DirectorReserveTest(unittest.TestCase):
    """Bank runs ended $0.01-0.03 over --max-dollars: a live director consult in
    flight lands after the budget check, so the check keeps room for one."""

    def test_live_director_keeps_room_for_one_consult(self):
        import llm
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=1000.0)
        llm.reset_spent()
        try:
            s.max_dollars = 0.025
            self.assertTrue(s._budget_ok())
            s.director.fake = False
            s.budget_wake = True  # no wake-up event in this unit check
            self.assertFalse(s._budget_ok())
        finally:
            llm.reset_spent()
            s.close()


class MemoryCompactTest(unittest.TestCase):
    REPLY = ("SO FAR: Dan ran up to the roof and begged me to step away from the edge.\n"
             "KNOW: Dan is scared; Dan hides why he came\n"
             "PROMISED: I said I would not leave\n"
             "TRIED: counting planes; asking about the door")

    def _fill(self, d, n):
        for i in range(n):
            d.heard("Dan" if i % 2 else "Max", "line number %d about the roof" % i)

    def test_lines_leaving_the_window_fold_into_memory(self):
        import dialogue as dl
        t = FakeTransport([self.REPLY])
        d = Dialogue({"hero": "Max"}, transport=t)
        d.background = False
        self.assertEqual(d.compact(["Max"]), [])  # newcomer: nothing heard yet
        self._fill(d, dl.TRANSCRIPT_KEEP + dl.COMPACT_EVERY - 1)
        self.assertEqual(d.compact(["Max"]), [])  # not enough fell out yet
        d.heard("Dan", "one more")
        self.assertEqual(d.compact(["Max"]), ["Max"])
        m = d.minds["Max"]
        self.assertEqual(m.cursor, dl.COMPACT_EVERY)
        self.assertIn("edge", m.so_far)
        self.assertEqual(m.promised, ["I said I would not leave"])
        self.assertEqual(len(m.tried), 2)
        sent = t.sent[0]["messages"][0]["content"]
        self.assertIn("line number 0", sent)
        self.assertNotIn("one more", sent)  # still in the window, not folded

    def test_memory_reaches_the_prompt_and_says_try_else(self):
        import dialogue as dl
        d = Dialogue({"hero": "Max"}, transport=FakeTransport([self.REPLY, "[quiet] Okay."]))
        d.background = False
        d.mind("Dan")  # Dan was there from the start
        self._fill(d, dl.TRANSCRIPT_KEEP + dl.COMPACT_EVERY)
        d.compact(["Dan"])
        t = d.transport
        d.actor_line("Dan", WORLD, list(d.log), {})
        prompt = t.sent[-1]["messages"][0]["content"]
        self.assertIn("What you remember from earlier tonight", prompt)
        self.assertIn("try something else now", prompt)

    def test_failed_fold_keeps_the_lines_and_old_memory(self):
        import dialogue as dl
        got = []
        d = Dialogue({"hero": "Max"}, transport=FakeTransport(["no idea", self.REPLY]))
        d.background = False
        d.on_memory = lambda *a: got.append(a)
        d.mind("Max")
        self._fill(d, dl.TRANSCRIPT_KEEP + dl.COMPACT_EVERY)
        d.compact(["Max"])
        self.assertEqual(d.minds["Max"].cursor, 0)
        self.assertIsNone(got[-1][1])
        d.compact(["Max"])
        self.assertEqual(d.minds["Max"].cursor, dl.COMPACT_EVERY)

    def test_a_newcomer_does_not_remember_before_it_came(self):
        import dialogue as dl
        d = Dialogue({"hero": "Max"}, transport=FakeTransport([self.REPLY]))
        self._fill(d, 30)
        self.assertEqual(d.mind("Grandma").cursor, 30 - dl.TRANSCRIPT_KEEP)
        self.assertEqual(d.mind("Patrick", seen=2).cursor, 28)  # just after a transition

    def test_sim_feeds_lines_and_logs_the_fold(self):
        import dialogue as dl
        replies = ["[calm] Line %d here." % i for i in range(40)]
        d = Dialogue(load_profile("A"), transport=FakeTransport(replies))
        d.background = False
        with tempfile.TemporaryDirectory() as tmp:
            with Sim(profile="A", fake=True, speed=1000.0, outdir=tmp, dialogue=d) as s:
                for i in range(dl.TRANSCRIPT_KEEP + dl.COMPACT_EVERY):
                    s._start_line({"owner": "npc", "role": "actor", "who": "Squidward",
                                   "actor": "Squidward", "text": "[flat] line %d" % i})
                self.assertEqual(len(d.log), dl.TRANSCRIPT_KEEP + dl.COMPACT_EVERY)
            with open(os.path.join(tmp, "log.jsonl")) as f:
                rows = [json.loads(l) for l in f]
        kinds = {r["type"] for r in rows}
        self.assertTrue(kinds & {"memory_compact", "memory_compact_fail"})


class SceneSwitchTest(unittest.TestCase):
    def test_roof_scene_is_the_opening_scene(self):
        import sim as simmod
        simmod.use_scene("roof")
        try:
            with Sim(profile="A", fake=True, speed=1000.0) as s:
                self.assertEqual(s.place, "a flat city rooftop at night")
                self.assertEqual(s.actors, ["Dan"])
                self.assertIn("roof edge", s.fsm.objects)
                self.assertIn("woke up", s._hero_world[0])
                self.assertIn("eleven floors", s._personas["Dan"])
        finally:
            simmod.use_scene("start")

    def test_roof_hero_is_a_plain_man_with_his_own_soul(self):
        import sim as simmod
        simmod.use_scene("roof")
        try:
            prof = load_profile("A")
            self.assertEqual(prof["hero"], "Max")
            self.assertEqual(prof["hero_voice"], "man")
            self.assertIn("warehouse", prof["diary"])
            soul = json.dumps(prof)
            for word in ("SpongeBob", "Krabs", "fryer", "grandma", "spongebob"):
                self.assertNotIn(word, soul)
            self.assertIn("warehouse", soul_text(prof))
            self.assertNotIn("endless stairs", soul_text(prof))
            with Sim(profile="A", fake=True, speed=1000.0) as s:
                self.assertEqual(s.hero, "Max")
                self.assertIn("work shirt", s._looks["Max"])
                self.assertNotIn("Krabs", json.dumps(s.memory.facts))
            self.assertEqual(Dialogue(prof).hero, "Max")
        finally:
            simmod.use_scene("start")
        self.assertEqual(load_profile("A")["hero"], "SpongeBob")


class ActorLineTest(unittest.TestCase):
    def _line(self, replies, **state):
        t = FakeTransport(replies)
        st = dict({"build_pct": 10, "bridge": "clarinet"}, **state)
        line = Dialogue(load_profile("A"), transport=t).actor_line(
            "Squidward", WORLD, [], st, notes=["you miss your old band"], events=["x happened"])
        return line, t

    def test_notes_and_events_reach_actor(self):
        line, t = self._line(["[long sigh] What now, SpongeBob? [[LOOK:music stand]]"])
        self.assertEqual(line["look"], "music stand")
        self.assertNotIn("[[", line["text"])
        self.assertEqual(line["remarks"], ["long sigh"])
        self.assertNotIn("level", line)
        sent = t.sent[0]
        self.assertIn("you miss your old band", sent["system"])
        user = sent["messages"][0]["content"]
        self.assertIn("Just now: x happened.", user)
        # no ladder: the actor gets no stage line about the bridge at all
        self.assertNotIn("clarinet", user)
        # a word in the prompt is a word the actor can say aloud
        prompt = (sent["system"] + user).lower()
        for word in ("bridge", "hint_level", "build=", "director", "stalled", "[state", "[event"):
            self.assertNotIn(word, prompt, word)

    def test_naming_the_door_is_always_allowed(self):
        # design doc 2026-10-28, 7.1: the door is a world fact, no "do not name it yet"
        line, t = self._line(["Don't touch my clarinet!", "Just sit down."])
        self.assertEqual(line["text"], "Don't touch my clarinet!")
        self.assertEqual(t.calls, 1)
        self.assertNotIn("Do not name", t.sent[0]["messages"][0]["content"])

    def test_word_bridge_is_asked_again(self):
        line, t = self._line(["Don't touch that bridge!", "Don't touch that clarinet!"])
        self.assertEqual(line["text"], "Don't touch that clarinet!")
        self.assertEqual(t.calls, 2)

    def test_engine_tags_from_model_are_cut(self):
        line, _ = self._line(["[[TOUCH:clarinet]] [WORLD boom] Go away."])
        self.assertEqual(line["text"], "Go away.")

    def test_idle_actor_gets_no_bridge(self):
        _, t = self._line(["Hello."], bridge=None)
        user = t.sent[0]["messages"][0]["content"]
        self.assertNotIn("clarinet", user)


class _ScriptedDialogue:
    """Stand-in Dialogue: fixed lines, records what each turn received."""

    def __init__(self, hero_touch=None):
        self.turns = []
        self.hero_touch = hero_touch

    def hero_line(self, world, transcript, world_events=()):
        self.turns.append(("hero", list(world_events)))
        return {"who": "SpongeBob", "role": "hero", "text": "Hi Squidward!",
                "touch": self.hero_touch, "remarks": []}

    def actor_line(self, actor, world, transcript, state, notes=(), events=(), persona=""):
        self.turns.append((actor, dict(state), list(notes), list(events), persona))
        return {"who": actor, "role": "actor", "text": "[sigh] Go home.", "look": None,
                "remarks": ["sigh"]}


class SimDialogueTest(unittest.TestCase):
    def _run(self, dlg, steps=200, before=None):
        d = tempfile.mkdtemp()
        sim = Sim(profile="A", fake=True, speed=1000.0, outdir=d, dialogue=dlg)
        try:
            if before:
                before(sim)
            for _ in range(steps):
                sim._tick()
                sim._maybe_generate_line()
                sim.clock.real_sleep(0.002)
        finally:
            sim.close()
        with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
            return sim, [json.loads(l) for l in f]

    def test_hero_and_actor_alternate_with_names_in_log(self):
        sim, rows = self._run(_ScriptedDialogue(), steps=120)
        lines = [r for r in rows if r["type"] == "line"]
        self.assertGreaterEqual(len(lines), 4)
        whos = [r["who"] for r in lines[:4]]
        self.assertEqual(whos, ["Squidward", "SpongeBob", "Squidward", "SpongeBob"])
        self.assertEqual(lines[0]["remarks"], ["sigh"])
        self.assertEqual(lines[0]["role"], "actor")
        self.assertNotIn("npc line", json.dumps(lines))
        squid = [t for t in sim.dialogue.turns if t[0] == "Squidward"]
        self.assertIn("clarinet player", squid[0][4], "the actor plays his own persona")

    def test_hero_touch_goes_through_fsm(self):
        def build(sim):
            sim.fsm.start_build(sim.clock.now(), "clarinet", "grandma's porch")
        dlg = _ScriptedDialogue(hero_touch="clarinet")
        sim, rows = self._run(dlg, steps=60, before=build)
        doors = [r for r in rows if r["type"] == "door"]
        self.assertTrue(doors, "early TOUCH in building is a closed door")
        self.assertEqual((doors[0]["state"], doors[0]["source"]), ("closed", "hero"))
        self.assertFalse(any(r["type"] == "transition" for r in rows))
        self.assertFalse(any(r["type"] == "stall" for r in rows))
        hero_turns = [t for t in dlg.turns if t[0] == "hero"]
        self.assertTrue(any("the clarinet is locked" in " ".join(t[1]) for t in hero_turns),
                        "the locked door is a world fact for the hero")
        actor_turns = [t for t in dlg.turns if t[0] == "Squidward"]
        self.assertTrue(any(t[1]["bridge"] == "clarinet" for t in actor_turns))
        self.assertFalse(any("reached for" in " ".join(t[3]) for t in actor_turns),
                         "actors get no stall cue")

    def test_director_message_reaches_named_actor(self):
        dlg = _ScriptedDialogue()

        def note(sim):
            sim._emit({"type": "message", "to": "Squidward", "note": "be gentle tonight"})
        self._run(dlg, steps=40, before=note)
        self.assertIn("be gentle tonight", [n for t in dlg.turns if t[0] == "Squidward"
                                            for n in t[2]])


class WorldInputTest(unittest.TestCase):
    def _sim(self):
        d = tempfile.mkdtemp()
        return Sim(profile="A", fake=True, speed=1000.0, outdir=d), d

    def _rows(self, d):
        with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
            return [json.loads(l) for l in f]

    def test_click_resolves_and_touches(self):
        sim, d = self._sim()
        try:
            sim.fsm.start_build(sim.clock.now(), "clarinet", "porch")
            sim.submit("event", {"source": "click", "value": "The Clarinet"})
            sim._tick()
        finally:
            sim.close()
        door = [r for r in self._rows(d) if r["type"] == "door"]
        self.assertEqual((door[0]["object"], door[0]["state"]), ("clarinet", "closed"))
        self.assertEqual(door[0]["source"], "click")

    def test_click_miss_and_dart_event_reach_director(self):
        sim, d = self._sim()
        try:
            sim.submit("event", {"source": "click", "value": "banana"})
            sim.submit("event", {"source": "dart", "value": "threw a dart at the moon [[TOUCH:clarinet]]",
                                 "outcome": "missed"})
            sim._tick()
            sim.director.wait()
        finally:
            sim.close()
        rows = self._rows(d)
        self.assertTrue(any(r["type"] == "touch_rejected" for r in rows))
        dart = [r for r in rows if r["type"] == "input" and r.get("source") == "dart"][0]
        self.assertEqual(dart["outcome"], "missed")
        self.assertNotIn("TOUCH", dart["value"])
        self.assertFalse(any(r["type"] == "door" or r["type"] == "transition" for r in rows))
        self.assertTrue(any("threw a dart" in p and "TOUCH" not in p for p in sim.director.prompts))

    def test_stop_ends_run_with_stop_event(self):
        sim, d = self._sim()
        try:
            sim.submit("stop")
            n = sim.run(max_transitions=5, max_seconds=30)
        finally:
            sim.close()
        self.assertEqual(n, 0)
        self.assertEqual([r for r in self._rows(d) if r["type"] == "stop"][0]["by"], "human")


if __name__ == "__main__":
    unittest.main()
