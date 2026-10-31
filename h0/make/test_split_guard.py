"""Красный тест F4: суммарные доли сплита не должны превышать 100%."""
import unittest

from make import core


class TestSplitGuard(unittest.TestCase):
    def test_split_over_100_rejected(self):
        with self.assertRaises(ValueError):
            core.parse_split("brief=100,refs=100")

    def test_split_negative_rejected(self):
        with self.assertRaises(ValueError):
            core.parse_split("world=-10")

    def test_split_unknown_stage_rejected(self):
        with self.assertRaises(ValueError):
            core.parse_split("nope=0")



from make.testkit import offline_spark_module  # noqa: E402
offline_spark_module(globals())

if __name__ == "__main__":
    unittest.main()

