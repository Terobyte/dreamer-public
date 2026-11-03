"""L76: an old-format stage folder becomes a link into .pub/ once, before any step; contents kept."""

import tempfile
import unittest
from pathlib import Path

from make import core


class MigrateLegacy(unittest.TestCase):
    def test_folder_becomes_link_with_same_contents(self):
        rd = Path(tempfile.mkdtemp())
        (rd / "stage").mkdir()
        (rd / "stage" / "stage.json").write_text("{}")
        core._migrate_legacy(rd, ["stage", "film"])
        self.assertTrue((rd / "stage").is_symlink())
        self.assertEqual((rd / "stage" / "stage.json").read_text(), "{}")
        self.assertFalse((rd / "film").exists())
        before = (rd / "stage").resolve()
        core._migrate_legacy(rd, ["stage"])  # a link is left alone
        self.assertEqual((rd / "stage").resolve(), before)

    def test_run_make_migrates_before_steps(self):
        rd = Path(tempfile.mkdtemp())
        (rd / "brief").mkdir()
        (rd / "brief" / "old.txt").write_text("x")
        seen = {}
        orig = core._migrate_legacy
        core._migrate_legacy = lambda r, s: (seen.setdefault("sids", list(s)), orig(r, s))
        try:
            core.run_make(rd, "a room", fake=True, until="brief")
        finally:
            core._migrate_legacy = orig
        self.assertIn("brief", seen["sids"])
        self.assertTrue((rd / "brief").is_symlink())


if __name__ == "__main__":
    unittest.main()
