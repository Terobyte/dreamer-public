"""F16/F23: смена --max-dollars меняет cap brief/refs -> они должны перезапуститься."""
import tempfile
import unittest
from pathlib import Path

from make import core


class TestCapInvalidates(unittest.TestCase):
    def test_changed_max_dollars_reruns_brief_refs(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run"
            core.run_make(p, prompt="p", max_dollars=10)
            r = core.run_make(p, prompt="p", max_dollars=20, only="brief")
            self.assertEqual(r["brief"], "ran")
            r2 = core.run_make(p, prompt="p", max_dollars=20, only="refs")
            self.assertEqual(r2["refs"], "ran")


if __name__ == "__main__":
    unittest.main()
