"""Regression: book mode never consults the director (phase K, F2).

post_event in a book run must only log the input row -- no consult row,
no consults/*.txt file -- so a live director can never make the
forbidden model call from a book run.
"""
import json
import os
import tempfile
import time
import unittest

from sim import Sim, _load_book_plan

HERE = os.path.dirname(os.path.abspath(__file__))


def _rows(tmp):
    path = os.path.join(tmp, "log.jsonl")
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


class BookPostEventNoConsult(unittest.TestCase):
    def test_post_event_starts_no_consult(self):
        tmp = tempfile.mkdtemp(prefix="book-noconsult-")
        plan = _load_book_plan(os.path.join(HERE, "books", "gwtw"), ["library"])
        sim = Sim(profile="A", fake=True, speed=50.0, outdir=tmp, book=plan)
        try:
            sim.post_event({"source": "tool", "value": "a loud knock"})
            wait = getattr(sim.director, "wait", None)
            if callable(wait):
                wait()
            else:
                time.sleep(1.0)
            kinds = [r.get("type") for r in _rows(tmp)]
            self.assertNotIn("consult", kinds)
            self.assertFalse(os.path.exists(os.path.join(tmp, "consults", "001.txt")))
        finally:
            close = getattr(sim, "close", None)
            if callable(close):
                close()


if __name__ == "__main__":
    unittest.main()
