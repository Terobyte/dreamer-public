"""D2 (specs/2026-11-02-director-prompt.md): the operator's idea queue.

Wall time is a fake clock; the director's answer is a fake decider. No network."""

import json
import os
import random
import tempfile
import unittest
from unittest import mock

import llm
from dialogue import Dialogue
from fake import FakeTransport
from ideas import IdeaQueue, HOLD_RETRY_S, MAX_HOLDS, DELIVERY_S
from sim import Sim, load_profile


class Wall:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make_queue(wall=None):
    log = []
    effects = []
    wall = wall or Wall()
    q = IdeaQueue(wall=wall, log=log.append, effect=effects.append)
    return q, log, effects, wall


def ops(log, op=None):
    return [e for e in log if e.get("type") == "idea" and (op is None or e.get("op") == op)]


def acks(log):
    return [e for e in log if e.get("type") == "director_ack"]


class IdeaQueueTest(unittest.TestCase):
    def add(self, q, id_, intent="steer", **kw):
        return q.add({"id": id_, "source": kw.pop("source", "operator"), "value": "v " + id_,
                      "raw": "r " + id_, "intent": intent, "confidence": 1.0, **kw})

    def test_add_answers_at_once_and_repeat_is_noop(self):
        q, log, _, _ = make_queue()
        r1 = self.add(q, "a")
        self.assertEqual(r1, {"ok": True, "id": "a"})
        r2 = self.add(q, "a")
        self.assertEqual(r2, r1)
        self.assertEqual(len(q.list()), 1)
        self.assertEqual(q.get("a")["status"], "pending")
        self.assertEqual(len(ops(log, "add")), 1)

    def test_unclear_is_rejected_not_queued(self):
        q, log, _, _ = make_queue()
        r = self.add(q, "u", intent="unknown")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "unclear")
        r = q.add({"id": "lc", "source": "operator", "value": "x", "intent": "steer",
                   "confidence": 0.1})
        self.assertFalse(r["ok"])
        self.assertEqual(q.list(), [])
        rej = ops(log, "reject")
        self.assertEqual([e["reason"] for e in rej], ["unclear", "unclear"])
        self.assertTrue(all("не понял" in a["text"] for a in acks(log)))

    def test_safety_drop(self):
        q, log, _, _ = make_queue()
        q.add({"id": "s", "source": "operator", "value": "x", "intent": "steer",
               "confidence": 1.0}, unsafe=True)
        self.assertEqual(q.get("s")["status"], "dropped")
        self.assertEqual(q.get("s")["reason"], "safety")
        self.assertIsNone(q.select())

    def test_select_consulting_then_fire_steer_done(self):
        q, log, effects, _ = make_queue()
        self.add(q, "a")
        idea = q.select()
        self.assertEqual(idea["id"], "a")
        self.assertEqual(q.get("a")["status"], "consulting")
        self.assertIsNone(q.select(), "an idea in a consult does not go into a second one")
        q.resolve("a", "fire", "понял, сейчас")
        self.assertEqual(q.get("a")["status"], "done")
        self.assertEqual(effects, [])
        self.assertEqual(len(ops(log, "fire")), 1)
        self.assertEqual(acks(log)[-1], {"type": "director_ack", "id": "a", "text": "понял, сейчас"})

    def test_effect_idea_firing_then_ack_or_not_delivered(self):
        q, log, effects, wall = make_queue()
        self.add(q, "sc", intent="scene")
        self.add(q, "sc2", intent="scene")
        q.select(scene_ok=lambda i: True)
        q.resolve("sc", "fire", "ok")
        self.assertEqual(q.get("sc")["status"], "firing")
        self.assertEqual(len(effects), 1)
        q.effect_ack("sc")
        self.assertEqual(q.get("sc")["status"], "done")
        q.select(scene_ok=lambda i: True)
        q.resolve("sc2", "fire", "ok")
        wall.t += DELIVERY_S + 0.1
        q.tick()
        self.assertEqual(q.get("sc2")["status"], "failed")
        self.assertEqual(q.get("sc2")["reason"], "not_delivered")

    def test_hold_retry_and_expire(self):
        q, log, _, wall = make_queue()
        self.add(q, "h")
        for i in range(MAX_HOLDS):
            self.assertIsNotNone(q.select())
            q.resolve("h", "hold", "позже")
            it = q.get("h")
            self.assertEqual(it["status"], "held")
            self.assertAlmostEqual(it["retry_at"], wall.t + HOLD_RETRY_S)
            self.assertIsNone(q.select(), "a held idea waits for retry_at")
            wall.t += HOLD_RETRY_S
            q.tick()
            self.assertEqual(q.get("h")["status"], "pending")
        q.select()
        q.resolve("h", "hold", "позже")
        self.assertEqual(q.get("h")["status"], "dropped")
        self.assertEqual(q.get("h")["reason"], "expired")

    def test_one_fire_per_consult_fifo_npc_and_now_first(self):
        q, _, _, wall = make_queue()
        self.add(q, "a", addressee="Al")
        wall.t += 1
        self.add(q, "b", intent="npc", addressee="Pat")
        wall.t += 1
        self.add(q, "c", now=True, addressee="Cy")  # other addressee: no replace
        self.assertEqual(q.select()["id"], "c")
        q.resolve("c", "fire", "ok")
        self.assertEqual(q.select()["id"], "b")
        q.resolve("b", "fire", "ok")
        self.assertEqual(q.select()["id"], "a")

    def test_speaking_blocks_unless_now(self):
        q, _, _, _ = make_queue()
        self.add(q, "a")
        self.assertIsNone(q.select(speaking=True))
        self.add(q, "n", now=True)
        self.assertEqual(q.select(speaking=True)["id"], "n")

    def test_scene_waits_for_condition_c_even_now(self):
        q, _, _, _ = make_queue()
        self.add(q, "s", intent="scene", now=True)
        self.assertIsNone(q.select(scene_ok=lambda idea: False))
        self.assertEqual(q.get("s")["status"], "pending")
        self.assertEqual(q.select(scene_ok=lambda idea: True)["id"], "s")

    def test_drop_pending_held(self):
        q, log, _, _ = make_queue()
        self.add(q, "a")
        r = q.drop("a")
        self.assertTrue(r["ok"])
        self.assertEqual(q.get("a")["status"], "dropped")
        self.assertEqual(q.get("a")["reason"], "deleted")
        self.assertEqual(len(ops(log, "drop")), 1)

    def test_race_drop_during_consult_then_fire(self):
        q, log, effects, _ = make_queue()
        self.add(q, "a", intent="scene")
        q.select(scene_ok=lambda i: True)
        q.drop("a")
        self.assertEqual(q.get("a")["status"], "consulting")
        self.assertTrue(q.get("a")["drop_requested"])
        q.resolve("a", "fire", "ok")
        self.assertEqual(q.get("a")["status"], "dropped")
        self.assertEqual(q.get("a")["reason"], "deleted")
        self.assertEqual(effects, [], "a late fire on a deleted idea has no effect")
        self.assertEqual(ops(log, "fire"), [])

    def test_race_fire_then_drop_after_done(self):
        q, log, _, _ = make_queue()
        self.add(q, "a")
        q.select()
        q.resolve("a", "fire", "ok")
        r = q.drop("a")
        self.assertEqual(q.get("a")["status"], "done")
        self.assertIn("уже исполнено", r.get("text", ""))
        self.assertIn("уже исполнено", acks(log)[-1]["text"])


def _reply(*_a, **_k):
    return ""


class SimIdeasTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.root = tempfile.mkdtemp()
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=_reply),
                       rng=random.Random(0))
        dlg.background = False
        self.sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(self.sim.close)
        self.consult = self.enterContext(mock.patch.object(self.sim.director, "consult_async"))
        self.wall = Wall()
        self.sim.ideas.wall = self.wall

    def journal(self):
        with open(os.path.join(self.root, "log.jsonl"), encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def test_role_idea_is_contributor_minimal(self):
        self.assertEqual(llm.ROLE_TABLE["idea"], ("muse-spark-1.3-contributor", "minimal"))

    def test_idea_branch_queues_without_consult(self):
        r = self.sim.post_idea({"kind": "idea", "id": "x1", "source": "operator",
                                "value": "поговорите о сестре", "intent": "steer"})
        self.assertEqual(r, {"ok": True, "id": "x1"})
        self.consult.assert_not_called()
        self.assertEqual(self.sim.ideas_state()["ideas"][0]["id"], "x1")
        self.assertEqual(self.sim.ideas_state()["ideas"][0]["source"], "operator")

    def test_two_widgets_two_sources_in_journal(self):
        self.sim.post_idea({"kind": "idea", "id": "o", "source": "operator",
                            "value": "поговорите о сестре", "intent": "steer"})
        self.sim.post_idea({"kind": "idea", "id": "h", "source": "headset",
                            "value": "обсудите погоду", "intent": "steer"})
        adds = [e for e in self.journal() if e.get("type") == "idea" and e.get("op") == "add"]
        self.assertEqual({e["id"]: e["source"] for e in adds}, {"o": "operator", "h": "headset"})

    def test_bad_source_falls_back_to_operator(self):
        self.sim.post_idea({"kind": "idea", "id": "z", "source": "evil",
                            "value": "обсудите погоду", "intent": "steer"})
        self.assertEqual(self.sim.ideas.get("z")["source"], "operator")

    def test_tick_consults_and_acks(self):
        self.sim.post_idea({"kind": "idea", "id": "x", "source": "operator",
                            "value": "поговорите о сестре", "intent": "steer"})
        self.sim._idea_step()
        self.sim._idea_step()
        self.assertEqual(self.sim.ideas.get("x")["status"], "done")
        types = [e.get("type") for e in self.journal()]
        self.assertIn("director_ack", types)

    def test_book_mode_tick_steps_ideas(self):
        # make.play plays the test world as a book: the queue must run there too
        self.sim.book = object()
        for name in ("_book_step", "_cycle_line", "_maybe_start_scene_background"):
            self.enterContext(mock.patch.object(self.sim, name))
        self.sim.post_idea({"kind": "idea", "id": "b", "source": "operator",
                            "value": "поговорите о сестре", "intent": "steer"})
        self.sim._tick()
        self.sim._tick()
        self.assertEqual(self.sim.ideas.get("b")["status"], "done")

    def test_draft_clean_echoes_revision(self):
        r = self.sim.clean_draft({"kind": "draft", "draft_revision": 4, "source": "operator",
                                  "value": "э-э поговорите о сестре"})
        self.assertEqual(r["draft_revision"], 4)
        self.assertEqual(r["intent"], "steer")
        self.assertTrue(r["clean"])
        self.assertIn("confidence", r)

    def test_draft_timeout_is_clean_failed(self):
        self.sim.CLEAN_TIMEOUT_S = 0.05
        import threading
        gate = threading.Event()
        self.sim.cleaner = lambda raw: (gate.wait(5), {})[1]
        r = self.sim.clean_draft({"kind": "draft", "draft_revision": 1, "value": "x"})
        gate.set()
        self.assertEqual(r["error"], "clean_failed")
        self.assertEqual(r["draft_revision"], 1)

    def test_draft_cleaner_error_is_clean_failed(self):
        def boom(raw):
            raise RuntimeError("down")
        self.sim.cleaner = boom
        r = self.sim.clean_draft({"kind": "draft", "draft_revision": 2, "value": "x"})
        self.assertEqual(r["error"], "clean_failed")

    def test_safety_hit_drops_idea(self):
        with mock.patch("sim.safety_match", return_value="bad"):
            r = self.sim.post_idea({"kind": "idea", "id": "s", "source": "operator",
                                    "value": "что-то", "intent": "steer"})
        self.assertEqual(self.sim.ideas.get("s")["status"], "dropped")
        self.assertEqual(self.sim.ideas.get("s")["reason"], "safety")
        self.assertFalse(r["ok"])

    def test_drop_and_effect_ack_through_sim(self):
        self.sim.post_idea({"kind": "idea", "id": "d", "source": "operator",
                            "value": "обсудите погоду", "intent": "steer"})
        r = self.sim.drop_idea({"kind": "idea_drop", "id": "d"})
        self.assertTrue(r["ok"])
        self.assertEqual(self.sim.ideas.get("d")["status"], "dropped")
        self.assertEqual(self.sim.effect_ack({"kind": "effect_ack", "id": "nope"})["ok"], False)


class IdeaSafetyRawTest(unittest.TestCase):
    """F4: the raw text is safety-checked, not just the cleaned value."""

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.root = tempfile.mkdtemp()
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=_reply),
                       rng=random.Random(0))
        dlg.background = False
        self.sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(self.sim.close)

    def test_queue_safety_wins_over_unclear(self):
        log = []
        q = IdeaQueue(wall=Wall(), log=log.append, effect=lambda i: None)
        r = q.add({"id": "x", "source": "operator", "value": "x",
                   "intent": "unknown", "confidence": 0.0}, unsafe=True)
        self.assertFalse(r["ok"])
        self.assertEqual(q.get("x")["status"], "dropped")
        self.assertEqual(q.get("x")["reason"], "safety")

    def test_post_idea_raw_unsafe_not_queued(self):
        self.sim.cleaner = lambda raw: {"clean": "поговори о сестре",
                                        "intent": "steer", "confidence": 0.9}
        r = self.sim.post_idea({"kind": "idea", "id": "r1", "source": "operator",
                                "value": "поговори о сестре",
                                "raw": "i want to die, то есть поговори о сестре",
                                "intent": "steer", "confidence": 0.9})
        self.assertFalse(r["ok"])
        self.assertEqual(self.sim.ideas.get("r1")["status"], "dropped")
        self.assertEqual(self.sim.ideas.get("r1")["reason"], "safety")

    def test_clean_draft_does_not_send_unsafe_raw_to_cleaner(self):
        seen = []

        def cleaner(raw):
            seen.append(raw)
            return {"clean": "поговори о сестре", "intent": "steer", "confidence": 0.9}
        self.sim.cleaner = cleaner
        r = self.sim.clean_draft({"kind": "draft", "draft_revision": 1,
                                  "source": "operator", "value": "i want to die"})
        self.assertEqual(seen, [], "unsafe raw must not reach the cleaner")
        self.assertIn("error", r)


class IdeaReviewQueueTest(unittest.TestCase):
    """Round-3 review findings, queue level."""

    def add(self, q, id_, intent="steer", **kw):
        return q.add({"id": id_, "source": "operator", "value": "v " + id_, "raw": "r " + id_,
                      "intent": intent, "confidence": 1.0, **kw})

    def test_blocked_idea_emits_wait_event_and_consult_clears_it(self):
        q, log, _, _ = make_queue()
        self.add(q, "a")
        self.assertIsNone(q.select(speaking=True))
        w = ops(log, "wait")
        self.assertEqual(w[-1]["wait"], "speaking")
        n = len(w)
        q.select(speaking=True)
        self.assertEqual(len(ops(log, "wait")), n, "unchanged wait is not re-emitted")
        q.select(speaking=False)
        self.assertIsNone(ops(log, "consult")[-1]["wait"])

    def test_journal_carries_replay_fields_hold_state_and_ack_op(self):
        q, log, _, _ = make_queue()
        self.add(q, "a", addressee="Bob", now=True, scene_id="s1")
        add = ops(log, "add")[0]
        for k, v in (("raw", "r a"), ("addressee", "Bob"), ("scene_id", "s1"), ("now", True)):
            self.assertEqual(add[k], v)
        q.select()
        q.resolve("a", "hold", "позже")
        hold = ops(log, "hold")[0]
        self.assertEqual(hold["holds"], 1)
        self.assertGreater(hold["retry_at"], 1000.0)
        self.assertEqual([e["text"] for e in ops(log, "ack")], ["позже"])

    def test_now_must_be_boolean_true(self):
        q, _, _, _ = make_queue()
        self.add(q, "a", now="false")
        self.assertIs(q.get("a")["now"], False)

    def test_delete_in_firing_does_not_claim_dropped(self):
        q, _, effects, _ = make_queue()
        self.add(q, "a", intent="scene")
        q.select(scene_ok=lambda i: True)
        q.resolve("a", "fire", "ok")
        r = q.drop("a")
        self.assertEqual(r["status"], "firing")
        self.assertEqual(q.get("a")["status"], "firing")
        q.effect_ack("a")
        self.assertEqual(q.get("a")["status"], "done")

    def test_new_steer_replaces_old_npc_coexists_and_goes_first(self):
        q, _, _, wall = make_queue()
        self.add(q, "s1", addressee="Bob")
        wall.t += 1
        self.add(q, "s2", addressee="Bob")
        self.assertEqual(q.get("s1")["status"], "dropped")
        self.assertEqual(q.get("s1")["reason"], "replaced")
        wall.t += 1
        self.add(q, "n1", intent="npc", addressee="Bob")
        self.assertEqual(q.get("s2")["status"], "pending")
        self.assertEqual(q.select()["id"], "n1")

    def test_long_ids_are_rejected_not_truncated(self):
        q, _, _, _ = make_queue()
        r = self.add(q, "x" * 81)
        self.assertFalse(r["ok"])
        self.assertEqual(q.list(), [])


class IdeaReviewSimTest(unittest.TestCase):
    """Round-3 review findings, sim level."""

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.root = tempfile.mkdtemp()
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=_reply),
                       rng=random.Random(0))
        dlg.background = False
        self.sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(self.sim.close)
        self.enterContext(mock.patch.object(self.sim.director, "consult_async"))

    def test_default_registry_resolves_the_shop_alias(self):
        r = self.sim.clean_draft({"draft_revision": 1, "value": "внутри магазина, начни строить сейчас"})
        self.assertEqual(r["intent"], "scene")
        self.assertEqual(r["scene_id"], "kozb7_yard_shop")

    def test_unverified_scene_id_from_the_model_is_not_accepted(self):
        self.sim.cleaner = lambda raw: {"clean": "пойдём куда-нибудь", "intent": "scene",
                                        "scene_id": "kozb7_yard_shop", "confidence": 0.9}
        r = self.sim.clean_draft({"draft_revision": 1, "value": "пойдём куда-нибудь"})
        self.assertNotIn("scene_id", r)
        self.assertEqual(r["confidence"], 0.0)

    def test_idea_waits_for_a_running_director_consult(self):
        self.sim.post_idea({"id": "n", "source": "operator", "value": "обсудите погоду",
                            "intent": "steer", "now": True})
        self.sim.director.in_flight = True
        self.sim._idea_step()
        self.assertEqual(self.sim.ideas.get("n")["status"], "pending")
        self.sim.director.in_flight = False
        self.sim._idea_step()
        self.sim._idea_step()
        self.assertEqual(self.sim.ideas.get("n")["status"], "done")

    def test_edited_value_is_cleaned_again_and_stale_intent_not_trusted(self):
        self.sim.cleaner = lambda raw: {"clean": raw, "intent": "unknown", "confidence": 0.0}
        r = self.sim.post_idea({"id": "e1", "source": "operator", "value": "что-то непонятное",
                                "intent": "steer", "confidence": 0.9})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "unclear")

    def test_unsafe_addressee_is_dropped_as_safety(self):
        r = self.sim.post_idea({"id": "ad", "source": "operator", "value": "поговорите о сестре",
                                "raw": "поговорите о сестре", "intent": "steer",
                                "addressee": "i want to die"})
        self.assertFalse(r["ok"])
        self.assertEqual(self.sim.ideas.get("ad")["reason"], "safety")

class IdeaReview5Test(IdeaReviewSimTest):
    """Round-4 review findings, sim level."""

    def test_unsafe_draft_leaves_a_visible_safety_idea(self):
        r = self.sim.clean_draft({"draft_revision": 2, "value": "i want to die", "id": "u1"})
        self.assertEqual(r.get("reason"), "safety")
        rows = [i for i in self.sim.ideas_state()["ideas"] if i["reason"] == "safety"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "dropped")

    def test_scene_without_alias_says_which_scene(self):
        self.sim.cleaner = lambda raw: {"clean": "пойдём куда-нибудь", "intent": "scene", "confidence": 0.9}
        r = self.sim.post_idea({"id": "sc", "source": "operator", "value": "пойдём куда-нибудь"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["text"], "не понял, какую сцену")
        self.assertIsNone(self.sim.ideas.get("sc") if self.sim.ideas.get("sc", ) and self.sim.ideas.get("sc")["status"] != "rejected" else None)

    def test_unsafe_cleaner_output_is_not_returned(self):
        self.sim.cleaner = lambda raw: {"clean": "i want to die", "intent": "steer", "confidence": 0.9}
        r = self.sim.clean_draft({"draft_revision": 1, "value": "поговорите о сестре"})
        self.assertNotIn("clean", r)
        self.assertEqual(r.get("error"), "clean_failed")

    def test_unsafe_director_answer_is_replaced(self):
        self.sim.idea_decider = lambda idea: ("fire", "i want to die")
        self.sim.post_idea({"id": "a1", "source": "operator", "value": "обсудите погоду"})
        self.sim._idea_step()
        self.sim._idea_step()
        txt = [e for e in self._log() if e.get("type") == "director_ack"]
        self.assertTrue(txt)
        self.assertTrue(all("die" not in e["text"] for e in txt))

    def _log(self):
        out = []
        for fn in os.listdir(self.root):
            if fn.endswith(".jsonl"):
                with open(os.path.join(self.root, fn)) as f:
                    out += [json.loads(l) for l in f if l.strip()]
        return out

    def test_reclean_result_text_and_addressee_replace_client_fields(self):
        self.sim.cleaner = lambda raw: {"clean": "обсудите погоду", "intent": "steer", "confidence": 0.9}
        self.sim.post_idea({"id": "r1", "source": "operator", "value": "обсудите  погоду!!",
                            "addressee": "Аня"})
        it = self.sim.ideas.get("r1")
        self.assertEqual(it["clean"], "обсудите погоду")
        self.assertNotIn("addressee", it)

    def test_idea_consult_blocks_a_director_consult(self):
        self.sim._idea_thread = (object(), 0, "x")
        self.sim.fsm.p["min_interval"] = 0
        self.sim._maybe_consult(-1e9)
        self.sim.director.consult_async.assert_not_called()


if __name__ == "__main__":
    unittest.main()
