"""F26: нечисловой/бесконечный бюджет отклоняется до запуска стадий."""
import tempfile
import unittest
from pathlib import Path

from make import core


class TestBudgetGuard(unittest.TestCase):
    def test_nan_budget_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "run"
            calls = []

            def fn(ctx):
                calls.append(1)
                return 0.0
            import dataclasses
            stages = {k: dataclasses.replace(s, fn=fn)
                      for k, s in core.default_stages().items()}
            with self.assertRaises(ValueError):
                core.run_make(run, prompt="p", stages=stages,
                              max_dollars=float("nan"))
            self.assertEqual(calls, [])

    def test_inf_budget_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "run"
            import dataclasses
            stages = {k: dataclasses.replace(s, fn=lambda ctx: 0.0)
                      for k, s in core.default_stages().items()}
            with self.assertRaises(ValueError):
                core.run_make(run, prompt="p", stages=stages,
                              max_dollars=float("inf"))


if __name__ == "__main__":
    unittest.main()
