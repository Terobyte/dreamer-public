"""Red test for F11: drama-3 promo vs list rate by date (spec section 13).
usage: cd h0/dream && python3 -m unittest test_contract_fish_dates -v
"""

import unittest

import llm


class FishDatesTest(unittest.TestCase):
    def test_drama3_promo_through_cutoff_then_list(self):
        llm.reset_spent()
        promo = llm.charge_fish(1000000, model="drama-3", when="2026-11-12")
        llm.reset_spent()
        listed = llm.charge_fish(1000000, model="drama-3", when="2026-11-13")
        self.assertAlmostEqual(promo, 10.0)
        self.assertAlmostEqual(listed, 50.0)

    def test_s2pro_ignores_date(self):
        llm.reset_spent()
        a = llm.charge_fish(1000000, model="s2-pro", when="2026-11-13")
        self.assertAlmostEqual(a, 15.0)


if __name__ == "__main__":
    unittest.main()
