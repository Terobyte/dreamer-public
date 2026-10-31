"""F1/F6/F11/F19: хэш stage учитывает файлы всех предков, не только прямых deps."""
import tempfile
import unittest
from pathlib import Path

from make import core


class TestAncestorHash(unittest.TestCase):
    def test_brief_change_reruns_only_stage(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run"
            core.run_make(p, prompt="p")
            (p / "brief" / "marker.txt").write_text("changed")
            r = core.run_make(p, prompt="p", only="stage")
            self.assertEqual(r["stage"], "ran")


if __name__ == "__main__":
    unittest.main()
