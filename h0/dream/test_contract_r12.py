"""Red tests for round findings F10-F14 (spec section 7).
usage: cd h0/dream && python3 -m unittest test_contract_r12 -q
"""

import json
import os
import tempfile
import threading
import unittest

from fake import FakeTransport
from memory import FACT_BUDGET, Memory


def raw_texts(m):
    out = []
    for f in sorted(os.listdir(m.raw_dir)):
        with open(os.path.join(m.raw_dir, f), encoding="utf-8") as fh:
            out.append(fh.read())
    return out


def fill_old_facts(m, n=40):
    m.apply_facts([{"op": "ADD", "fact": {"title": "old%d" % i,
                                          "text": "x" * 120}}
                   for i in range(n)])
    assert m._facts_cost(m.facts) > FACT_BUDGET


class BlockingTransport(FakeTransport):
    def __init__(self, script=()):
        super().__init__(script)
        self.gate = threading.Event()
        self.entered = threading.Event()

    def complete(self, **kw):
        self.entered.set()
        self.gate.wait(2)
        return super().complete(**kw)


class R12Test(unittest.TestCase):
    def test_f10_dropped_events_archived(self):
        m = Memory(tempfile.mkdtemp())
        for i in range(101):
            m.add_event({"source": "input", "value": "e%03d" % i})
        prompt, _ = m.build_prompt({})
        self.assertTrue("e000" in prompt
                        or any("e000" in t for t in raw_texts(m)))
        self.assertLessEqual(len(m.events), 100)

    def test_f11_identical_blocks_all_archived(self):
        m = Memory(tempfile.mkdtemp())
        counts = []
        for _ in range(3):
            for i in range(200):
                m.add_line("hero", "same line %d " % i + "y" * 40)
            m.build_prompt({})
            counts.append(len(os.listdir(m.raw_dir)))
        self.assertLess(counts[0], counts[1])
        self.assertLess(counts[1], counts[2])

    def test_f12_decisions_on_disk_bounded(self):
        root = tempfile.mkdtemp()
        m = Memory(root)
        for i in range(500):
            m.record_decision({"bridge": str(i), "destination": "d%d" % i})
        self.assertLessEqual(len(m.decisions), 20)
        with open(os.path.join(root, "decisions.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f if l.strip()]
        self.assertEqual(len(rows), 500)
        prompt, _ = m.build_prompt({})
        self.assertIn("499", prompt)
        self.assertIn("earlier transitions", prompt)

    def test_f13_selection_once_per_scene(self):
        t = FakeTransport(["f1 f2"])
        m = Memory(tempfile.mkdtemp(), transport=t)
        fill_old_facts(m)
        m.set_scene("lagoon", ["rock"])
        m.build_prompt({})
        m.select_facts_background().join(2)
        first = [f["id"] for f in m._facts_for_prompt()]
        self.assertEqual(t.calls, 1)
        m.select_facts_background().join(2)
        self.assertEqual(t.calls, 1)
        self.assertEqual([f["id"] for f in m._facts_for_prompt()], first)

    def test_f14_scene_change_during_selection_requeues(self):
        t = BlockingTransport(["f1 f2"])
        m = Memory(tempfile.mkdtemp(), transport=t)
        fill_old_facts(m)
        m.set_scene("lagoon", ["rock"])
        th1 = m.select_facts_background()
        self.assertTrue(t.entered.wait(2))
        m.set_scene("krusty krab", ["grill"])
        th2 = m.select_facts_background()
        t.gate.set()
        th1.join(2)
        th2.join(2)
        self.assertEqual(t.calls, 2)
        self.assertEqual(m._sel_done_epoch, m._scene_epoch)


if __name__ == "__main__":
    unittest.main()
