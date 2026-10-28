"""Red tests for phase contract gaps (spec section 7).
usage: cd h0/dream && python3 -m unittest -q
"""

import tempfile
import unittest

from memory import BudgetError, HARD_CAP, Memory


def make_mem():
    m = Memory(root=tempfile.mkdtemp())
    m.set_core(desire="wants quiet after the fight",
               anxiety="fears the boss shouting again",
               scene="squidward living room",
               objects=["clarinet", "old radio"],
               bridge="none yet")
    return m


class ContractTrimTest(unittest.TestCase):
    def test_hard_cap_never_exceeded(self):
        m = make_mem()
        m.set_core(desire="D" * 30000)
        with self.assertRaises(BudgetError) as cm:
            m.build_prompt({})
        self.assertIn('director_fail("budget")', str(cm.exception))

    def test_decisions_counter(self):
        m = make_mem()
        for i in range(10):
            m.record_decision({"bridge": "b%d" % i,
                               "destination": "d%d" % i,
                               "why": "w%d" % i})
        text, _ = m.build_prompt({})
        self.assertIn("5 earlier transitions", text)


if __name__ == "__main__":
    unittest.main()
