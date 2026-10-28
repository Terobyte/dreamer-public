"""Red tests for round findings F1-F4 (spec sections 6, 7, 13).
usage: cd h0/dream && python3 -m unittest test_contract_round -q
"""

import os
import tempfile
import unittest

import llm
from fake import FakeTransport
from memory import LAYER_BUDGET, LAYER_BUDGETS, BudgetError, Memory


def make_mem(**kw):
    m = Memory(root=tempfile.mkdtemp(), **kw)
    m.set_core(desire="wants quiet after the fight",
               anxiety="fears the boss shouting again",
               scene="squidward living room",
               objects=["clarinet", "old radio"],
               bridge="clarinet")
    return m


def layer_sum(sizes):
    return sum(sizes[k] for k in ("core", "working", "episodes", "facts", "decisions"))


class RoundRedTest(unittest.TestCase):
    def test_f1_layer_sum_bounded(self):
        m = make_mem()
        m.set_core(desire="D" * 1200, anxiety="A" * 550,
                   scene="squidward living room",
                   objects=["clarinet", "old radio"], bridge="clarinet")
        for i in range(300):
            m.add_line("hero", "line %d about quiet evening clarinet song " % i + "x" * 40)
        for i in range(10):
            m.record_decision({"bridge": "b%d" % i,
                               "destination": "place %d " % i + "P" * 100,
                               "why": "reason %d " % i + "W" * 130})
        m.save_episode_raw("ep1", "EPBODY " * 425)
        m.merge_from_raw()
        for i in range(4):
            m.apply_facts([{"op": "ADD", "fact": {"title": "fact%d" % i,
                                                 "text": "factbody %d " % i + "y" * 500}}])
        try:
            text, sizes = m.build_prompt({})
        except BudgetError as e:
            self.assertIn('director_fail("budget")', str(e))
            return  # raising instead of over-budget prompt is allowed
        self.assertLessEqual(layer_sum(sizes), LAYER_BUDGET)

    def test_f2_working_note_fits(self):
        m = make_mem()
        m.add_line("hero", "short line")
        m.add_line("actor", "z" * 3480)
        text, sizes = m.build_prompt({})
        self.assertLessEqual(sizes["working"], LAYER_BUDGETS["working"])

    def test_f3_first_attempt_charged_on_retry_error(self):
        llm.reset_spent()

        class PricedThenFail:
            def __init__(self):
                self.calls = 0
                self.sent = []

            def complete(self, model, effort, system, messages, max_tokens):
                self.calls += 1
                self.sent.append({"max_tokens": max_tokens})
                if self.calls == 1:
                    return {"content": "", "usage": {"prompt_tokens": 10,
                                                     "completion_tokens": 0}}
                raise RuntimeError("boom")

        tr = PricedThenFail()
        with self.assertRaises(RuntimeError):
            llm.call("director", "sys", [{"role": "user", "content": "hi"}],
                     max_tokens=500, fake=True, _transport=tr)
        self.assertAlmostEqual(llm.get_spent(), 10 * 4.0 / 1000000.0)

    def test_f4_eid_traversal_rejected(self):
        m = make_mem()
        with self.assertRaises(ValueError):
            m.save_episode_raw("../../escaped", "x")
        parent = os.path.dirname(m.root.rstrip("/"))
        self.assertFalse(os.path.exists(os.path.join(parent, "escaped")))
        self.assertFalse(os.path.exists(os.path.abspath(
            os.path.join(m.raw_dir, "../../escaped"))))


if __name__ == "__main__":
    unittest.main()
