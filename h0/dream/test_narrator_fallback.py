"""Red test: books without narrator_voice keep the previous narrator voice (contract)."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import sim

HERE = Path(__file__).resolve().parent
JANE = HERE / "books" / "jane-eyre"


class NarratorFallback(unittest.TestCase):
    def test_missing_field_keeps_default_voice(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / "book"
            shutil.copytree(JANE, book)
            bj = json.loads((book / "book.json").read_text())
            bj.pop("narrator_voice", None)
            (book / "book.json").write_text(json.dumps(bj))
            plan = sim._load_book_plan(str(book))
            # прежний голос рассказчика, не KeyError/None
            self.assertIsInstance(plan.get("narrator_voice"), str)
            self.assertTrue(plan["narrator_voice"])


if __name__ == "__main__":
    unittest.main()
