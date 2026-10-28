"""Red tests for blocking findings (spec sections 6, 7, 13).
usage: cd h0/dream && python3 -m unittest test_contract_blocking -q
"""

import os
import tempfile
import unittest

import llm
from fake import FakeTransport
from memory import BudgetError, LAYER_BUDGETS, Memory


def make_mem(**kw):
    m = Memory(root=tempfile.mkdtemp(), **kw)
    m.set_core(desire="wants quiet", anxiety="fears shouting",
               scene="squidward living room",
               objects=["clarinet", "old radio"], bridge="none yet")
    return m


class BlockingTest(unittest.TestCase):
    def test_model_ids_and_prices(self):
        self.assertEqual(llm.resolve("hero")[0], "meta-models/muse-spark-open-1026")  # owner 2026-10-27: Baseten primary
        self.assertEqual(llm.resolve("director")[0], "muse-wonder-1.0")
        self.assertEqual((llm.SPARK_IN_PER_M, llm.SPARK_OUT_PER_M), (1.25, 4.25))
        self.assertEqual((llm.WONDER_IN_PER_M, llm.WONDER_OUT_PER_M), (4.0, 20.0))
        self.assertEqual(llm.IMAGE_PER_PIC, 0.01)
        for v in llm.PRICE_SOURCES.values():
            self.assertIn("2026-10-27", v)
            self.assertIn("http", v)

    def test_fish_charged_by_utf8_bytes(self):
        llm.reset_spent()
        # e-acute is 2 UTF-8 bytes; 1000 of them = 2000 bytes at $15/1M bytes
        self.assertAlmostEqual(llm.charge_fish("é" * 1000), 0.03)

    def test_core_over_budget_raises(self):
        m = make_mem()
        m.set_core(desire="D" * 2200, anxiety="a", scene="s",
                   objects=["clarinet"], bridge="none yet")
        with self.assertRaises(BudgetError):
            m.build_prompt({})

    def test_oldest_only_trimmed_others_intact(self):
        m = make_mem()
        m.episodes = [
            {"id": "old", "text": "OLDFIRST\n" + "oldrest " * 400},
            {"id": "new", "text": "NEWFIRST\nNEWBODY stays whole"}]
        for i in range(50):
            m.add_event("ev %d " % i + "q" * 300)
        text, sizes = m.build_prompt({})
        self.assertIn("OLDFIRST", text)
        self.assertNotIn("oldrest oldrest", text)
        self.assertIn("NEWBODY stays whole", text)
        self.assertLessEqual(sizes["episodes"], LAYER_BUDGETS["episodes"])

    def test_unresolvable_overflow_raises_not_silent_drop(self):
        m = make_mem()
        m.episodes = [
            {"id": "old", "text": "OLDFIRST\n" + "oldrest " * 400},
            {"id": "new", "text": "NEWFIRST\n" + "newrest " * 4000}]
        with self.assertRaises(BudgetError):
            m.build_prompt({})

    def test_merge_progresses_and_uses_spark(self):
        fake = FakeTransport(script=["merged summary"])
        m = make_mem(transport=fake)
        m.save_episode_raw("a", "A raw")
        m.save_episode_raw("b", "B raw")
        m.save_episode_raw("c", "C raw")
        m.merge_from_raw()
        self.assertEqual(fake.calls, 1)
        self.assertEqual(fake.sent[0]["model"], "meta-models/muse-spark-open-1026")
        self.assertEqual(len(m.episodes), 2)
        m.merge_from_raw()
        self.assertEqual(len(m.episodes), 1)
        # second merge input must be raw A+B+C, not the summary
        sent2 = fake.sent[-1]["messages"][0]["content"]
        self.assertIn("A raw", sent2)
        self.assertIn("C raw", sent2)
        self.assertNotIn("merged summary", sent2)
        for eid in ("a", "b", "c"):
            self.assertTrue(os.path.exists(os.path.join(m.raw_dir, eid + ".txt")))

    def test_merge_without_transport_is_not_fake_summary(self):
        m = make_mem()
        m.save_episode_raw("a", "A raw")
        m.save_episode_raw("b", "B raw")
        m.merge_from_raw()
        self.assertEqual(len(m.episodes), 2)

    def test_facts_background_selection_then_prompt_no_llm(self):
        fake = FakeTransport(script=["old1 old3"])
        m = make_mem(transport=fake)
        for i in range(6):
            m.facts.append({"id": "f%d" % i, "title": "old%d" % i,
                            "text": "factbody%d " % i + "x" * 600,
                            "supersedes_id": None, "scene_epoch": -1})
        m.select_facts_background().join(timeout=5)
        self.assertGreaterEqual(fake.calls, 1)
        calls = fake.calls
        text, _ = m.build_prompt({})
        self.assertEqual(fake.calls, calls)
        self.assertIn("factbody1", text)
        self.assertIn("factbody3", text)

    def test_build_prompt_never_calls_llm(self):
        fake = FakeTransport(script=["old0"])
        m = make_mem(transport=fake)
        for i in range(6):
            m.facts.append({"id": "f%d" % i, "title": "old%d" % i,
                            "text": "factbody%d " % i + "x" * 600,
                            "supersedes_id": None, "scene_epoch": -1})
        m.build_prompt({})
        self.assertEqual(fake.calls, 0)


if __name__ == "__main__":
    unittest.main()
