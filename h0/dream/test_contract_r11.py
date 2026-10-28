"""Red tests for round findings F1-F8 (spec sections 7, 13).
usage: cd h0/dream && python3 -m unittest test_contract_r11 -q
"""

import os
import tempfile
import unittest

import llm
from fake import FakeTransport
from memory import FACT_BUDGET, BudgetError, Memory


def make_mem(root=None, **kw):
    m = Memory(root=root or tempfile.mkdtemp(), **kw)
    m.set_core(desire="wants quiet", anxiety="fears the boss",
               scene="squidward living room", objects=["clarinet"],
               bridge="clarinet")
    return m


def raw_texts(m):
    out = []
    for f in os.listdir(m.raw_dir):
        with open(os.path.join(m.raw_dir, f), encoding="utf-8") as fh:
            out.append(fh.read())
    return out


class R11Test(unittest.TestCase):
    def test_f1_long_last_line_archived_whole(self):
        m = Memory(tempfile.mkdtemp())
        m.add_line("hero", "old")
        m.add_line("hero", "z" * 14000)
        m.build_prompt({})
        self.assertTrue(any("z" * 14000 in t for t in raw_texts(m)))

    def test_f2_stale_selection_dropped(self):
        m = make_mem()
        for i in range(6):
            m.apply_facts([{"op": "ADD", "fact": {"title": "old%d" % i,
                                                 "text": "y" * 600}}])
        m.set_scene("krusty krab", ["grill"])

        class Racing(FakeTransport):
            def complete(self, **kw):
                m.set_scene("jellyfish fields", ["net"])
                m.apply_facts([{"op": "ADD", "fact": {"title": "freshfact",
                                                     "text": "short"}}])
                return super().complete(**kw)

        m.transport = Racing(["f1"])
        m.select_facts_background().join(2)
        text, _ = m.build_prompt({})
        self.assertIn("freshfact", text)

    def test_f3_reloaded_facts_are_old(self):
        root = tempfile.mkdtemp()
        m = make_mem(root)
        m.apply_facts([{"op": "ADD", "fact": {"title": "prior", "text": "t"}}])
        m2 = make_mem(root)
        text, _ = m2.build_prompt({})
        self.assertIn("prior", text)
        self.assertNotIn("NEW THIS SCENE", text)

    def test_f4_active_lists_bounded(self):
        m = make_mem()
        for i in range(2000):
            m.add_line("hero", "line %d " % i + "x" * 60)
            m.add_event({"source": "hero", "type": "say", "value": "v%d" % i})
            if i % 50 == 0:
                m.build_prompt({})
        m.build_prompt({})
        self.assertLess(len(m.lines), 200)
        self.assertLess(len(m.events), 200)

    def test_f5_facts_layer_within_budget_or_raises(self):
        m = make_mem()
        for i in range(3):
            m.apply_facts([{"op": "ADD", "fact": {"title": "old%d" % i,
                                                 "text": "o" * 700}}])
        m.set_scene("krusty krab", ["grill"])
        m.apply_facts([{"op": "ADD", "fact": {"title": "new", "text": "n" * 1400}}])
        _, sizes = m.build_prompt({})
        self.assertLessEqual(sizes["facts"], FACT_BUDGET)
        for i in range(4):
            m.apply_facts([{"op": "ADD", "fact": {"title": "big%d" % i,
                                                 "text": "b" * 520}}])
        with self.assertRaises(BudgetError):
            m.build_prompt({})

    def test_f6_exact_id_match(self):
        m = make_mem()
        for i in range(1, 11):
            m.apply_facts([{"op": "ADD", "fact": {"title": "t%d" % i,
                                                 "text": "y" * 700}}])
        m.set_scene("krusty krab", ["grill"])
        m.transport = FakeTransport(["f10"])
        picked = m._select_facts()
        ids = [f["id"] for f in picked]
        self.assertIn("f10", ids)
        self.assertNotIn("f1", ids)

    def test_f7_merge_instruction_fields(self):
        m = make_mem()
        m.save_episode_raw("ep1", "one")
        m.save_episode_raw("ep2", "two")
        fake = FakeTransport(["merged"])
        m.merge_from_raw(transport=fake)
        system = fake.sent[0]["system"]
        for field in ("WHAT HAPPENED", "HERO WANTED", "HERO REACTION",
                      "BRIDGE AND WHY"):
            self.assertIn(field, system)

    def test_f8_drama3_promo_ends_17utc(self):
        llm.reset_spent()
        before = llm.charge_fish(1000000, model="drama-3",
                                 when="2026-11-12T16:59:00+00:00")
        after = llm.charge_fish(1000000, model="drama-3",
                                when="2026-11-12T17:00:00+00:00")
        self.assertAlmostEqual(before, 10.0)
        self.assertAlmostEqual(after, 50.0)


if __name__ == "__main__":
    unittest.main()
