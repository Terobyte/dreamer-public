"""Red test for F4: Fish TTS tariff is per-model (spec section 13).
usage: cd h0/dream && python3 -m unittest test_contract_fish -v
"""

import unittest

import llm


class FishTariffTest(unittest.TestCase):
    def test_drama3_uses_own_rate(self):
        llm.reset_spent()
        s2 = llm.charge_fish(1000000, model="s2-pro")
        llm.reset_spent()
        drama = llm.charge_fish(1000000, model="drama-3")
        self.assertAlmostEqual(s2, 15.0)
        # Promo $10/M through 2026-11-12, list $50/M after; either way != s2-pro.
        self.assertNotEqual(drama, s2)
        self.assertIn(drama, (10.0, 50.0))


if __name__ == "__main__":
    unittest.main()
