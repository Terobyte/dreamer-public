"""Offline tests for live hero/actor lines (spec 4-6, 5a; H17 ladder).
usage: cd h0/dream && python3 -m unittest test_dialogue -q
"""

import json
import os
import tempfile
import unittest

from dialogue import Dialogue, soul_text, state_tag
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

    def test_state_tag(self):
        self.assertEqual(state_tag(2, 40), "[STATE hint_level=2 build=40%]")
        self.assertEqual(state_tag(1, 20, True), "[STATE hint_level=1 build=20% stalled=true]")


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
        self.assertIn("[WORLD you are in Squidward's living room", user)
        self.assertIn("Squidward: Go home.", user)

    def test_touch_is_rare(self):
        t = FakeTransport(["Ooh! [[TOUCH:clarinet]]", "Wow! [[TOUCH:radio]]", "Hm. [[TOUCH:radio]]",
                           "Hey. [[TOUCH:radio]]", "Look! [[TOUCH:suitcase]]"])
        d = Dialogue(load_profile("A"), transport=t)
        touches = [d.hero_line(WORLD, [])["touch"] for _ in range(5)]
        self.assertEqual(touches, ["clarinet", None, None, None, "suitcase"])

    def test_empty_reply_gives_none(self):
        self.assertIsNone(Dialogue({}, transport=FakeTransport([""])).hero_line(WORLD, []))


class RepeatTest(unittest.TestCase):
    def test_repeated_hero_line_is_asked_again(self):
        t = FakeTransport(["[softly] Can we just stay quiet here a little longer?",
                           "Look -- the radio is humming grandma's song!"])
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
        t = FakeTransport(["Ha! You're not Dan."])
        line = Dialogue(load_profile("A"), transport=t, rng=Always(1)).hero_line(WORLD, [])
        self.assertIn(line["impulse"], HERO_IMPULSES)
        self.assertIn("[IMPULSE right now, out of nowhere: %s]" % line["impulse"],
                      t.sent[0]["messages"][0]["content"])

    def test_actor_never_gets_an_impulse(self):
        import random as _r

        class Always(_r.Random):
            def random(self):
                return 0.0
        t = FakeTransport(["Get away from the edge!"])
        Dialogue({}, transport=t, rng=Always(1)).actor_line(
            "Dan", WORLD, [], {"hint_level": 0, "build_pct": 0, "stalled": False, "bridge": None})
        self.assertNotIn("IMPULSE", t.sent[0]["messages"][0]["content"])
        from llm import ROLE_TEMPERATURE
        self.assertNotIn("actor", ROLE_TEMPERATURE)

    def test_no_impulse_when_dice_say_no(self):
        import random as _r

        class Never(_r.Random):
            def random(self):
                return 0.99
        t = FakeTransport(["Hi."])
        line = Dialogue({}, transport=t, rng=Never(1)).hero_line(WORLD, [])
        self.assertIsNone(line["impulse"])
        self.assertNotIn("IMPULSE", t.sent[0]["messages"][0]["content"])


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


class ActorLineTest(unittest.TestCase):
    def _line(self, replies, **state):
        t = FakeTransport(replies)
        st = dict({"hint_level": 0, "build_pct": 10, "stalled": False, "bridge": "clarinet"}, **state)
        line = Dialogue(load_profile("A"), transport=t).actor_line(
            "Squidward", WORLD, [], st, notes=["you miss your old band"], events=["x happened"])
        return line, t

    def test_state_notes_and_events_reach_actor(self):
        line, t = self._line(["[long sigh] What now, SpongeBob? [[LOOK:music stand]]"], hint_level=1)
        self.assertEqual(line["look"], "music stand")
        self.assertNotIn("[[", line["text"])
        self.assertEqual(line["remarks"], ["long sigh"])
        sent = t.sent[0]
        self.assertIn("you miss your old band", sent["system"])
        user = sent["messages"][0]["content"]
        self.assertIn("[STATE hint_level=1 build=10%]", user)
        self.assertIn("[BRIDGE clarinet]", user)
        self.assertIn("[EVENT x happened]", user)

    def test_low_level_line_naming_bridge_is_asked_again_then_dropped(self):
        line, t = self._line(["Don't touch my clarinet!", "Just sit down."], hint_level=0)
        self.assertEqual(line["text"], "Just sit down.")
        self.assertEqual(t.calls, 2)
        line, t = self._line(["My clarinet!", "The clarinet!"], hint_level=1)
        self.assertIsNone(line)
        line, _ = self._line(["Fine, play the clarinet."], hint_level=3)
        self.assertEqual(line["text"], "Fine, play the clarinet.")

    def test_word_bridge_is_asked_again(self):
        line, t = self._line(["Don't touch that bridge!", "Don't touch that clarinet!"], hint_level=3)
        self.assertEqual(line["text"], "Don't touch that clarinet!")
        self.assertEqual(t.calls, 2)

    def test_engine_tags_from_model_are_cut(self):
        line, _ = self._line(["[[TOUCH:clarinet]] [WORLD boom] Go away."])
        self.assertEqual(line["text"], "Go away.")

    def test_idle_actor_gets_no_bridge(self):
        _, t = self._line(["Hello."], bridge=None)
        user = t.sent[0]["messages"][0]["content"]
        self.assertNotIn("BRIDGE", user)
        self.assertNotIn("build=", user)


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
                "remarks": ["sigh"], "level": state["hint_level"]}


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
        stalls = [r for r in rows if r["type"] == "stall"]
        self.assertTrue(stalls, "early TOUCH in building is a stall")
        self.assertEqual(stalls[0]["source"], "hero")
        actor_turns = [t for t in dlg.turns if t[0] == "Squidward"]
        self.assertTrue(any(t[1]["stalled"] and t[1]["bridge"] == "clarinet" for t in actor_turns))
        self.assertTrue(any("reached for the clarinet" in " ".join(t[3]) for t in actor_turns))

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
        stall = [r for r in self._rows(d) if r["type"] == "stall"]
        self.assertEqual(stall[0]["object"], "clarinet")
        self.assertEqual(stall[0]["source"], "click")

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
        self.assertFalse(any(r["type"] == "stall" or r["type"] == "transition" for r in rows))
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
