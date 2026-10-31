"""F11: story input_hash uses stable relative paths (absolute book.dir safe), sorted."""
import os
import shutil
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import core

JANE = Path(__file__).resolve().parents[1] / "dream" / "books" / "jane-eyre"


class NoNet(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network"))
        p.start()
        self.addCleanup(p.stop)


class StoryHashPaths(NoNet):
    def test_book_inputs_relative_and_sorted(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / "deep" / "book"
            shutil.copytree(JANE, book)
            assert os.path.isabs(str(book))
            run = Path(tmp) / "run"
            seen = {}
            orig = core.input_hash

            def spy(stage, version, params, inputs):
                if stage == "story":
                    seen["inputs"] = [list(r) for r in inputs]
                return orig(stage, version, params, inputs)

            with mock.patch.object(core, "input_hash", side_effect=spy):
                res = core.run_make(run, "p", fake=True, until="story",
                                    book=str(book), scene="tea")
            self.assertEqual(res["story"], "ran", res)
            self.assertIn("inputs", seen)
            paths = [r[0] for r in seen["inputs"]]
            self.assertTrue(paths)
            for p in paths:
                self.assertFalse(os.path.isabs(p), f"absolute path in hash inputs: {p}")
            self.assertEqual(paths, sorted(paths))
            self.assertTrue(any(p == "book.json" or p.endswith("/book.json") for p in paths))
            self.assertTrue(any(p == "ch13.txt" or p.endswith("/ch13.txt") for p in paths))


if __name__ == "__main__":
    unittest.main()
