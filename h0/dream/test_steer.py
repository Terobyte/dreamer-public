"""D3 (specs/2026-11-02-director-prompt.md, stage 1 + 2в): steer and addressed npc
ideas reach the actor's notes. Fake LLM, fake wall clock, no network."""

import json
import os
import random
import tempfile
import unittest
from unittest import mock

from dialogue import Dialogue
from fake import FakeTransport
from sim import Sim, load_profile

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures",
                       "steer_topics.json")


class Wall:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def topics():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


class SteerFixtureTest(unittest.TestCase):
    def test_three_topics(self):
        got = {t["phrase"]: t["topic_words"] for t in topics()}
        self.assertEqual(got, {"поговорите о сестре": ["сестр"],
                               "обсудите погоду": ["погод", "дожд", "солнц"],
                               "расскажите про школу": ["школ", "учител", "урок"]})


class SteerSimTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.root = tempfile.mkdtemp()
        self.transport = FakeTransport(reply=self._reply)
        dlg = Dialogue(load_profile("A"), transport=self.transport, rng=random.Random(0))
        dlg.background = False
        self.sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(self.sim.close)
        self.enterContext(mock.patch.object(self.sim.director, "consult_async"))
        self.wall = Wall()
        self.sim.ideas.wall = self.wall
        if len(self.sim.actors) < 2:
            self.sim.actors.append("Мира")  # a second NPC for the addressee tests
        self.a, self.b = list(self.sim.actors)[:2]

    @staticmethod
    def _reply(model, effort, system, messages):
        # the fake actor speaks the topic it was given in its notes, else small talk
        if "on your mind" not in system:
            return "Ну и денёк сегодня."
        for t in topics():
            for w in t["topic_words"]:
                if w in system.lower():
                    return "Я всё думаю: %s… как там оно." % (w + "е" if w == "сестр" else w)
        return "Ну и денёк сегодня."

    def journal(self):
        with open(os.path.join(self.root, "log.jsonl"), encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def fire(self, id_, text, intent="steer", addressee=None):
        out = {"clean": text, "intent": intent, "confidence": 0.9}
        if addressee:
            out["addressee"] = addressee
        self.sim.cleaner = lambda raw: out
        r = self.sim.post_idea({"kind": "idea", "id": id_, "source": "operator", "value": text})
        self.assertTrue(r["ok"], r)
        self.sim._idea_step()
        return self.sim.ideas.get(id_)

    def notes(self, who):
        return " ".join(self.sim._line_notes(who)).lower()

    def test_steer_topic_in_addressee_notes_and_ack_in_one_consult(self):
        idea = self.fire("s1", "поговорите о сестре", addressee=self.a)
        self.assertEqual(idea["status"], "done")
        self.assertIn("сестр", self.notes(self.a))
        self.assertNotIn("сестр", self.notes(self.b))
        ack = [e for e in self.journal() if e.get("type") == "director_ack" and e["id"] == "s1"]
        self.assertEqual(len(ack), 1)

    def test_steer_lives_six_addressee_lines(self):
        self.fire("s1", "поговорите о сестре", addressee=self.a)
        for _ in range(3):
            self.sim._note_line(self.b, "actor", "что-то другое")
        for _ in range(5):
            self.sim._note_line(self.a, "actor", "реплика")
        self.assertIn("сестр", self.notes(self.a))
        self.sim._note_line(self.a, "actor", "реплика")
        self.assertNotIn("сестр", self.notes(self.a))

    def test_steer_without_addressee_counts_any_npc(self):
        self.fire("s1", "обсудите погоду")
        self.assertIn("погод", self.notes(self.a))
        self.assertIn("погод", self.notes(self.b))
        for i in range(6):
            self.sim._note_line(self.a if i % 2 else self.b, "actor", "реплика")
        self.assertNotIn("погод", self.notes(self.a))

    def test_steer_expires_after_60s_wall(self):
        self.fire("s1", "поговорите о сестре", addressee=self.a)
        self.wall.t += 59
        self.sim._idea_step()
        self.assertIn("сестр", self.notes(self.a))
        self.wall.t += 2
        self.sim._idea_step()
        self.assertNotIn("сестр", self.notes(self.a))

    def test_tried_is_not_cleared(self):
        mind = self.sim.dialogue.mind(self.a)
        mind.tried = ["спросил про сестру"]
        self.fire("s1", "поговорите о сестре", addressee=self.a)
        self.assertEqual(self.sim.dialogue.mind(self.a).tried, ["спросил про сестру"])

    def test_dropped_before_fire_does_not_touch_dialogue(self):
        self.sim.cleaner = lambda raw: {"clean": raw, "intent": "steer", "confidence": 0.9,
                                        "addressee": self.a}
        self.sim.post_idea({"kind": "idea", "id": "d", "source": "operator",
                            "value": "поговорите о сестре"})
        self.sim.drop_idea({"kind": "idea_drop", "id": "d"})
        self.sim._idea_step()
        self.assertEqual(self.sim.ideas.get("d")["status"], "dropped")
        self.assertNotIn("сестр", self.notes(self.a))

    def test_new_steer_same_npc_replaces(self):
        self.fire("s1", "поговорите о сестре", addressee=self.a)
        self.fire("s2", "обсудите погоду", addressee=self.a)
        self.assertIn("погод", self.notes(self.a))
        self.assertNotIn("сестр", self.notes(self.a))

    def test_next_line_of_addressee_speaks_topic(self):
        self.fire("s1", "поговорите о сестре", addressee=self.a)
        self.enterContext(mock.patch.object(self.sim, "_pick_speaker",
                                            return_value=(self.a, "actor")))
        self.sim._last_tick = -1e9
        self.sim._gen_not_before = -1e9
        self.sim._dialogue_turn()
        self.assertIsNotNone(self.sim._gen_thread)
        self.sim._gen_thread.join(5)
        line = self.sim._gen_result[0]
        self.assertIn("сестр", line["text"].lower())
        self.assertIn("сестр", self.transport.sent[-1]["system"].lower())

    def test_panel_command_sister_within_six_lines(self):
        # the panel: draft -> clean -> idea; the fake cleaner has no addressee: any NPC
        d = self.sim.clean_draft({"kind": "draft", "draft_revision": 1, "source": "operator",
                                  "value": "поговорите о сестре"})
        self.sim.post_idea({"kind": "idea", "id": "p", "source": "operator", "value": d["clean"]})
        self.sim._idea_step()
        self.assertEqual(self.sim.ideas.get("p")["status"], "done")
        self.enterContext(mock.patch.object(self.sim, "_pick_speaker",
                                            return_value=(self.a, "actor")))
        said = []
        for _ in range(6):
            self.sim._last_tick = -1e9
            self.sim._gen_not_before = -1e9
            self.sim.next_line = self.sim.prepared_npc = None
            self.sim._dialogue_turn()
            self.sim._gen_thread.join(5)
            line = self.sim._gen_result[0]
            said.append(line["text"].lower())
            self.sim._gen_result = None
            self.sim._gen_taken = None
            self.sim._note_line(self.a, "actor", line["text"])
        self.assertTrue(any("сестр" in s for s in said), said)

    # --- 2в: addressed npc ---------------------------------------------------
    def test_npc_goes_to_addressee_once_and_keeps_steer(self):
        self.fire("s1", "обсудите погоду", addressee=self.b)
        idea = self.fire("n1", "расскажи про школу", intent="npc", addressee=self.a)
        self.assertEqual(idea["status"], "done")
        self.assertIn("школ", self.notes(self.a))
        self.assertNotIn("школ", self.notes(self.b))
        self.assertIn("погод", self.notes(self.b))  # the common steer is untouched
        self.assertIn("школ", " ".join(self.sim._line_notes(self.a, consume=True)).lower())
        self.assertNotIn("школ", self.notes(self.a))
        fires = [e for e in self.journal()
                 if e.get("type") == "idea" and e.get("op") == "fire" and e["id"] == "n1"]
        self.assertEqual(len(fires), 1)

    def test_npc_outranks_steer_in_next_line(self):
        # decision 7: both for the same NPC -- the npc cue is for this very line, the
        # steer topic explicitly waits; after the cue is played the steer is plain again
        self.fire("s1", "обсудите погоду", addressee=self.a)
        self.fire("n1", "расскажи про школу", intent="npc", addressee=self.a)
        got = " ".join(self.sim._line_notes(self.a, consume=True)).lower()
        now, _, later = got.partition("after that")
        self.assertIn("школ", now)
        self.assertNotIn("погод", now)
        self.assertIn("погод", later)
        self.assertIn("steer the talk to this", self.notes(self.a))
        self.assertNotIn("after that", self.notes(self.a))
        self.assertNotIn("школ", self.notes(self.a))

    def test_npc_without_addressee_holds_then_drops(self):
        idea = self.fire("n1", "расскажи про школу", intent="npc", addressee="Призрак")
        self.assertEqual(idea["status"], "held")
        for _ in range(7):
            self.wall.t += 10
            self.sim._idea_step()
        idea = self.sim.ideas.get("n1")
        self.assertEqual((idea["status"], idea["reason"]), ("dropped", "no_addressee"))

    def test_npc_addressee_gone_after_fire_fails(self):
        self.fire("n1", "расскажи про школу", intent="npc", addressee=self.a)
        self.sim.actors.remove(self.a)
        self.sim._idea_step()
        idea = self.sim.ideas.get("n1")
        self.assertEqual((idea["status"], idea["reason"]), ("failed", "addressee_gone"))


    def test_npc_appearing_later_needs_new_idea(self):
        # F1: seen missing once -> never fires, even if the NPC shows up later
        idea = self.fire("n1", "расскажи про школу", intent="npc", addressee="Призрак")
        self.assertEqual(idea["status"], "held")
        self.sim.actors.append("Призрак")
        self.wall.t += 10
        self.sim._idea_step()
        idea = self.sim.ideas.get("n1")
        self.assertEqual(idea["status"], "held")
        for _ in range(6):
            self.wall.t += 10
            self.sim._idea_step()
        idea = self.sim.ideas.get("n1")
        self.assertEqual((idea["status"], idea["reason"]), ("dropped", "no_addressee"))

    def test_npc_gone_after_line_start_fails(self):
        # F2: the cue is consumed at generation start; the actor leaves before
        # his line is ready -> the idea fails instead of staying done
        self.fire("n1", "расскажи про школу", intent="npc", addressee=self.a)
        self.sim._line_notes(self.a, consume=True)
        self.sim.actors.remove(self.a)
        self.sim._idea_step()
        idea = self.sim.ideas.get("n1")
        self.assertEqual((idea["status"], idea["reason"]), ("failed", "addressee_gone"))


    # --- F3: the addressee leaves while his line is in flight -------------------
    def test_f3_gone_addressee_line_is_dropped(self):
        self.fire("n1", "расскажи про школу", intent="npc", addressee=self.a)
        self.enterContext(mock.patch.object(self.sim, "_pick_speaker",
                                            return_value=(self.a, "actor")))
        self.sim._last_tick = -1e9
        self.sim._gen_not_before = -1e9
        self.sim._dialogue_turn()  # starts the generation (the cue is consumed)
        self.sim.actors.remove(self.a)  # the addressee leaves mid-flight
        self.sim._gen_thread.join(5)
        self.sim._idea_step()  # fails the idea: addressee_gone
        self.sim.active_line = None
        self.sim.next_line = self.sim.prepared_npc = None
        n_before = len(self.journal())
        self.sim._dialogue_turn()  # takes the finished result: must drop it
        idea = self.sim.ideas.get("n1")
        self.assertEqual((idea["status"], idea["reason"]), ("failed", "addressee_gone"))
        self.assertIsNone(self.sim.active_line)
        self.assertIsNone(self.sim.prepared_npc)
        fresh = self.journal()[n_before:]
        self.assertFalse([e for e in fresh
                          if e.get("type") == "line" and e.get("who") == self.a], fresh)

    def test_f3_prepared_line_of_gone_actor_is_dropped(self):
        # F3, prepared path: the line was prepared while the addressee was
        # present; he leaves before _cycle_line voices it -> dropped, no line
        self.fire("n1", "расскажи про школу", intent="npc", addressee=self.a)
        self.enterContext(mock.patch.object(self.sim, "_pick_speaker",
                                            return_value=(self.a, "actor")))
        self.sim._last_tick = -1e9
        self.sim._gen_not_before = -1e9
        self.sim.active_line = {"owner": "npc", "who": self.b, "text": "занято"}
        self.sim._dialogue_turn()  # starts the generation (the cue is consumed)
        self.sim._gen_thread.join(5)
        self.sim._dialogue_turn()  # busy line -> line_prepared, not started
        self.assertIsNotNone(self.sim.prepared_npc)
        self.sim.active_line = None
        self.sim.actors.remove(self.a)  # the addressee leaves before voicing
        self.sim._idea_step()  # fails the idea: addressee_gone
        n_before = len(self.journal())
        self.sim._cycle_line()  # must drop the prepared line, not voice it
        idea = self.sim.ideas.get("n1")
        self.assertEqual((idea["status"], idea["reason"]), ("failed", "addressee_gone"))
        self.assertIsNone(self.sim.active_line)
        self.assertIsNone(self.sim.prepared_npc)
        fresh = self.journal()[n_before:]
        self.assertFalse([e for e in fresh
                          if e.get("type") == "line" and e.get("who") == self.a], fresh)

    # --- F4: a failed generation must not lose the cue ---------------------------
    def test_f4_failed_generation_keeps_cue(self):
        self.fire("n1", "расскажи про школу", intent="npc", addressee=self.a)
        self.enterContext(mock.patch.object(self.sim, "_pick_speaker",
                                            return_value=(self.a, "actor")))
        with mock.patch.object(self.sim.dialogue, "actor_line",
                               side_effect=RuntimeError("boom")):
            self.sim._last_tick = -1e9
            self.sim._gen_not_before = -1e9
            self.sim._dialogue_turn()  # starts the generation (the cue is consumed)
            self.sim._gen_thread.join(5)
            self.sim._dialogue_turn()  # takes the None result: turn_skip
        idea = self.sim.ideas.get("n1")
        if idea["status"] == "failed":
            self.assertTrue(idea["reason"], "an explicit failure needs a reason")
        else:
            self.assertIn("школ", self.notes(self.a))  # the cue is back for his next line

    # --- F6: the addressee is checked when the consult resolves, before op:fire ----
    def test_f6_addressee_gone_during_consult_holds_not_fires(self):
        def decider(idea):
            self.sim.actors.remove(self.a)  # leaves while the consult runs
            return "fire", "понял"
        self.sim.idea_decider = decider
        idea = self.fire("n1", "расскажи про школу", intent="npc", addressee=self.a)
        self.assertEqual(idea["status"], "held")
        self.assertEqual([e for e in self.journal()
                          if e.get("type") == "idea" and e.get("op") == "fire"], [])
        for _ in range(7):
            self.wall.t += 10
            self.sim._idea_step()
        idea = self.sim.ideas.get("n1")
        self.assertEqual((idea["status"], idea["reason"]), ("dropped", "no_addressee"))

    # --- F7: no fire while the addressee's prompt is already being generated -------
    def test_f7_steer_waits_for_running_generation(self):
        import threading
        gate = threading.Event()
        orig = self.transport.reply

        def slow(model, effort, system, messages):
            gate.wait(5)
            return orig(model, effort, system, messages)
        self.transport.reply = slow
        self.enterContext(mock.patch.object(self.sim, "_pick_speaker",
                                            return_value=(self.a, "actor")))
        self.sim._last_tick = -1e9
        self.sim._gen_not_before = -1e9
        self.sim._dialogue_turn()  # prompt built without any topic, request blocked
        self.assertTrue(self.sim._gen_thread.is_alive())
        idea = self.fire("s1", "поговорите о сестре", addressee=self.a)
        self.assertEqual(idea["status"], "pending")  # waits, not fired
        gate.set()
        self.sim._gen_thread.join(5)
        self.sim._dialogue_turn()  # takes the topic-less line
        self.sim.active_line = self.sim.prepared_npc = self.sim.next_line = None
        self.sim._idea_step()
        self.assertEqual(self.sim.ideas.get("s1")["status"], "done")
        self.assertIn("сестр", self.notes(self.a))

    def test_f7_async_consult_resolving_after_generation_start_waits(self):
        """F7: the consult runs on its thread; the addressee starts generating before it
        answers fire -> the fire waits until that topic-less line is played."""
        import threading
        import time as _t
        gate_d, gate_g = threading.Event(), threading.Event()
        self.enterContext(mock.patch.object(self.sim, "_decide_idea",
                                            lambda idea: (gate_d.wait(5), ("fire", "понял"))[1]))
        orig = self.transport.reply

        def slow(model, effort, system, messages):
            gate_g.wait(5)
            return orig(model, effort, system, messages)
        self.transport.reply = slow
        self.enterContext(mock.patch.object(self.sim, "_pick_speaker",
                                            return_value=(self.a, "actor")))

        def step_async():
            self.sim.fake = False  # the real (threaded) consult path
            try:
                self.sim._idea_step()
            finally:
                self.sim.fake = True
        self.sim.cleaner = lambda raw: {"clean": "поговорите о сестре", "intent": "steer",
                                        "confidence": 0.9, "addressee": self.a}
        self.assertTrue(self.sim.post_idea({"kind": "idea", "id": "s1", "source": "operator",
                                            "value": "поговорите о сестре"})["ok"])
        step_async()  # consult thread started, blocked
        self.assertIsNotNone(self.sim._idea_thread)
        self.sim._last_tick = -1e9
        self.sim._gen_not_before = -1e9
        self.sim._dialogue_turn()  # his prompt is built now, without the topic
        self.assertTrue(self.sim._gen_thread.is_alive())
        gate_d.set()
        for _ in range(100):
            if self.sim._idea_result is not None:
                break
            _t.sleep(0.01)
        self.assertIsNotNone(self.sim._idea_result)
        step_async()
        self.assertNotEqual(self.sim.ideas.get("s1")["status"], "done")
        self.assertEqual([e for e in self.journal()
                          if e.get("type") == "idea" and e.get("op") == "fire"], [])
        gate_g.set()
        self.sim._gen_thread.join(5)
        self.sim._dialogue_turn()  # takes the topic-less line
        step_async()
        self.assertNotEqual(self.sim.ideas.get("s1")["status"], "done")  # still playing
        self.sim.active_line = self.sim.prepared_npc = self.sim.next_line = None
        step_async()
        self.assertEqual(self.sim.ideas.get("s1")["status"], "done")
        self.assertIn("сестр", self.notes(self.a))
        self.assertEqual(self.sim._steer[self.a]["left"], self.sim.STEER_LINES)  # all six ahead


if __name__ == "__main__":
    unittest.main()
