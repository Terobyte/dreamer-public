"""L78: a make stage's Spark ledger has a dollar ceiling once the run has a budget."""

import tempfile
import unittest
from pathlib import Path

from make import core


def ctx(budget):
    d = Path(tempfile.mkdtemp())
    return core.Ctx(run_dir=d, out=d, params={}, resume=False, budget_usd=budget, opts={})


class SparkLedgerCap(unittest.TestCase):
    def test_no_budget_no_dollar_cap(self):
        self.assertEqual(core.spark_ledger(ctx(None), 2).cap_usd, float("inf"))

    def test_share_is_the_cap_but_one_call_always_fits(self):
        small = core.spark_ledger(ctx(0.01), 2)
        self.assertTrue(0.01 < small.cap_usd < 1.0)
        big = core.spark_ledger(ctx(5.0), 2)
        self.assertEqual(big.cap_usd, 5.0)
        self.assertEqual(big.cap_calls, 2)


if __name__ == "__main__":
    unittest.main()
