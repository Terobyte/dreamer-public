"""Offline contract tests for director memory (spec sections 7, 13).
usage: cd h0/dream && python3 -m unittest -q
"""

import json
import math
import os
import tempfile
import unittest

from fake import FakeTransport
from memory import HARD_CAP, Memory


def make_mem():
    m = Memory(root=tempfile.mkdtemp())
    m.set_core(desire="wants quiet after the fight",
               anxiety="fears the boss shouting again",
               scene="squidward living room",
               objects=["clarinet", "old radio"],
               bridge="none yet")
    return m


def total_of(text):
    return math.ceil(len(text) / 3.5)


class BudgetTest(unittest.TestCase):
    def test_budget_300_lines(self):
        m = make_mem()
        for i in range(300):
            who = "hero" if i % 2 == 0 else "actor"
            m.add_line(who, "line %d about the quiet evening and the clarinet song " % i
                       + "x" * 40)
        for i in range(10):
            m.record_decision({"bridge": "obj%d" % i,
                               "destination": "place %d" % i,
                               "why": "test decision %d" % i})
        for i in range(50):
            m.add_event({"type": "input", "source": "dart",
                         "value": "throw %d at the moon" % i,
                         "outcome": "missed"})
        for _ in range(300):
            text, sizes = m.build_prompt({})
            self.assertTrue(text)
            self.assertLessEqual(sizes["total"], 5800)
            self.assertLessEqual(total_of(text), 5800)

    def test_core_always_present(self):
        m = make_mem()
        m.set_core(desire="wants quiet after the fight",
                   anxiety="fears the boss shouting again",
                   scene="squidward living room",
                   objects=["clarinet", "old radio"], bridge="clarinet")
        for i in range(300):
            m.add_line("hero", "filler line %d " % i + "y" * 40)
        for i in range(10):
            m.record_decision({"bridge": "b%d" % i, "destination": "d%d" % i,
                               "why": "w%d" % i})
        m.save_episode_raw("ep1", "raw one first line\n" + "raw one rest " * 200)
        m.save_episode_raw("ep2", "raw two first line\n" + "raw two rest " * 200)
        m.merge_from_raw()
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "t", "text": "some fact"}}])
        for _ in range(3):
            text, _ = m.build_prompt({"events": ["event %d " % j + "e" * 60
                                                 for j in range(50)]})
            self.assertIn("wants quiet after the fight", text)
            self.assertIn("fears the boss shouting again", text)
            self.assertIn("squidward living room", text)
            self.assertIn("bridge: clarinet", text)
            self.assertIn("TAIL summary", text)

    def test_merge_from_raw(self):
        m = make_mem()
        m.save_episode_raw("ep1", "RAW ONE about the lullaby evening")
        m.save_episode_raw("ep2", "RAW TWO about the bus station goodbye")
        m.episodes = [{"id": "stale",
                       "text": "STALE SUMMARY that must not be used"}]
        m.merge_from_raw()
        text, _ = m.build_prompt({})
        self.assertIn("RAW ONE", text)
        self.assertIn("RAW TWO", text)
        self.assertNotIn("STALE SUMMARY", text)

    def test_trim_without_llm(self):
        fake = FakeTransport(script=["should never be consumed"])
        m = Memory(root=tempfile.mkdtemp(), transport=fake)
        m.set_core(desire="wants quiet after the fight",
                   anxiety="fears the boss shouting again",
                   scene="squidward living room",
                   objects=["clarinet", "old radio"], bridge="none yet")
        for i in range(300):
            m.add_line("actor", "overflow line %d " % i
                       + "z" * 60)
        for i in range(50):
            m.add_event("burst event %d " % i + "z" * 60)
        text, sizes = m.build_prompt({})
        self.assertEqual(fake.calls, 0)
        self.assertIn("TAIL summary", text)
        self.assertLessEqual(sizes["total"], HARD_CAP)
        self.assertLessEqual(total_of(text), HARD_CAP)

    def test_facts_supersede(self):
        m = make_mem()
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "calm",
                                 "text": "hero relaxes when music is mentioned"}}])
        text, _ = m.build_prompt({})
        self.assertIn("relaxes when music", text)
        fid = m.facts[0]["id"]
        m.apply_facts([{"op": "UPDATE", "id": fid, "supersedes_id": fid,
                        "fact": {"title": "calm",
                                 "text": "hero hates loud music now"}}])
        text, _ = m.build_prompt({})
        self.assertIn("hates loud music", text)
        self.assertNotIn("relaxes when music", text)
        m.set_scene("porch at dusk", ["rocking chair", "old radio"])
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "porch",
                                 "text": "porch fact fresh"}}])
        text, _ = m.build_prompt({})
        self.assertIn("porch fact fresh", text)


class FactsContractTest(unittest.TestCase):
    def test_add_string_fact(self):
        # Spec section 8 example passes fact as a plain string.
        m = make_mem()
        m.apply_facts([{"op": "ADD",
                        "fact": "hero relaxes when music is mentioned"}])
        text, _ = m.build_prompt({})
        self.assertIn("relaxes when music", text)

    def test_supersedes_id_persisted(self):
        m = make_mem()
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "calm",
                                 "text": "hero relaxes when music"}}])
        fid = m.facts[0]["id"]
        m.apply_facts([{"op": "UPDATE", "id": fid, "supersedes_id": fid,
                        "fact": {"title": "calm",
                                 "text": "hero hates loud music now"}}])
        with open(m.facts_path, encoding="utf-8") as f:
            rows = [json.loads(l) for l in f if l.strip()]
        self.assertTrue(rows)
        for row in rows:
            self.assertIn("supersedes_id", row)
        self.assertEqual(rows[-1]["supersedes_id"], fid)

    def test_same_scene_add_keeps_prior_picks(self):
        # Selection is once per scene; a same-scene ADD must append
        # the new fact without replacing previously picked old ones.
        m = make_mem()
        for i in range(6):
            m.apply_facts([{"op": "ADD",
                            "fact": {"title": "old%d" % i,
                                     "text": "x" * 600}}])
        m.set_scene("porch at dusk", ["rocking chair"])
        before, _ = m.build_prompt({})
        picked = ["old%d" % i for i in range(6) if "old%d" % i in before]
        self.assertTrue(picked)
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "fresh",
                                 "text": "y" * 60}}])
        after, _ = m.build_prompt({})
        self.assertIn("fresh", after)
        for title in picked:
            self.assertIn(title, after)


if __name__ == "__main__":
    unittest.main()
