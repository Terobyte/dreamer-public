"""stage reads the book (narrator_voice, the scene's room) and the voice pool; a change there must rebuild it.
Koshakan, Nov 1: book narrator_voice -> "gentle", `make --only stage` answered "cached", the film kept the old voice."""
import json
import shutil
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import core

JANE = Path(__file__).resolve().parents[1] / "dream" / "books" / "jane-eyre"


class StageHashBook(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network"))
        p.start()
        self.addCleanup(p.stop)

    def test_book_change_rebuilds_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / "book"
            shutil.copytree(JANE, book)
            run = Path(tmp) / "run"
            res = core.run_make(run, "p", fake=True, until="stage", book=str(book), scene="tea")
            self.assertEqual(res["stage"], "ran", res)
            bj = json.loads((book / "book.json").read_text())
            bj["narrator_voice"] = "gentle"
            (book / "book.json").write_text(json.dumps(bj))
            res = core.run_make(run, "p", fake=True, only="stage", book=str(book), scene="tea")
            self.assertEqual(res["stage"], "ran", res)
            sj = json.loads((run / "stage" / "stage.json").read_text())
            self.assertEqual(sj["narrator_voice"], "gentle")

    def test_lang_change_rebuilds_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / "book"
            shutil.copytree(JANE, book)
            run = Path(tmp) / "run"
            # first build en
            res = core.run_make(run, "p", fake=True, until="stage", book=str(book), scene="tea")
            self.assertEqual(res["stage"], "ran", res)
            # same run with ru must not be cached – hash includes lang
            from make import story as mstory
            from unittest import mock as umock
            with umock.patch.object(mstory, "fake_translate", lambda t, l: list(t)):
                res2 = core.run_make(run, "p", fake=True, only="stage", book=str(book), scene="tea", lang="ru")
                self.assertEqual(res2["stage"], "ran", res2)
                sj = json.loads((run / "stage" / "stage.json").read_text())
                self.assertEqual(sj.get("lang"), "ru")


if __name__ == "__main__":
    unittest.main()
