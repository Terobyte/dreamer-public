"""Red contract tests for book.py (block K1): text -> draft score.
usage: cd h0/dream && python3 -m unittest -q test_book
"""
import json
import os
import re
import shutil
import tempfile
import unittest

import book as B

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK_DIR = os.path.join(HERE, "books", "gwtw")


def _paras():
    with open(os.path.join(BOOK_DIR, "ch06.txt"), encoding="utf-8") as f:
        text = f.read()
    return re.split(r"\n\s*\n", text.strip())


class ParseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.book = B.load_book(BOOK_DIR)
        cls.scores = {sid: B.score_scene(BOOK_DIR, sid) for sid in ("lawn", "library", "hall")}

    def beats(self, sid, para):
        return [b for b in self.scores[sid]["beats"] if b["para"] == para]

    def lines(self, sid, para):
        return [b for b in self.beats(sid, para) if b["kind"] == "line"]

    def test_paragraph_count(self):
        self.assertEqual(len(_paras()), 280)

    def test_lawn_rhett_and_continuation(self):
        l = self.lines("lawn", 114)
        self.assertEqual(len(l), 1)
        self.assertEqual(l[0]["who"], "Rhett Butler")
        self.assertTrue(l[0]["tag"].startswith("said Rhett Butler"))
        self.assertEqual(self.lines("lawn", 117)[0]["who"], "Rhett Butler")
        self.assertEqual(self.lines("lawn", 123)[0]["who"], "Stuart Tarleton")
        l = self.lines("lawn", 125)
        self.assertEqual(len(l), 1)
        self.assertIn("Napoleon", l[0]["text"])
        self.assertIn("strongest battalion", l[0]["text"])
        self.assertIn("'God is on the side", l[0]["text"])
        self.assertEqual(l[0]["who"], "Rhett Butler")

    def test_multi_quote_paragraph_and_tag_cut(self):
        l = self.lines("lawn", 107)
        self.assertEqual(len(l), 1)
        self.assertEqual(l[0]["who"], "India Wilkes")
        self.assertTrue(l[0]["text"].startswith("War!"))
        self.assertIn("Yankees", l[0]["text"])
        l = self.lines("lawn", 100)
        self.assertEqual(l[0]["who"], "Jim Tarleton")
        self.assertNotIn("thought", l[0]["tag"])

    def test_thought_is_narration(self):
        for p in (79, 83):
            self.assertEqual(self.lines("lawn", p), [])
            n = self.beats("lawn", p)
            self.assertEqual([b["kind"] for b in n], ["narration"])
            self.assertIn('"', n[0]["text"])
        self.assertTrue(self.beats("lawn", 83)[0]["text"].startswith('"What a fool!"'))

    def test_unattributed_112(self):
        self.assertIsNone(self.lines("lawn", 112)[0]["who"])
        self.assertTrue(any(w.startswith("unattributed: 112") for w in self.scores["lawn"]["warnings"]))

    def test_exchange_205_206(self):
        self.assertIn(self.lines("library", 205)[0]["who"], ("Scarlett O'Hara", None))
        self.assertEqual(self.lines("library", 206)[0]["who"], "Rhett Butler")

    def test_library_whole(self):
        s = self.scores["library"]
        lines = [b for b in s["beats"] if b["kind"] == "line"]
        self.assertGreaterEqual(len(lines), 30)
        names = {b["who"] for b in lines if b["who"]}
        self.assertLessEqual(names, {"Scarlett O'Hara", "Ashley Wilkes", "Rhett Butler"})
        self.assertEqual(self.lines("library", 144)[0]["who"], "Ashley Wilkes")
        self.assertEqual(self.lines("library", 147)[0]["who"], "Ashley Wilkes")
        self.assertEqual(self.lines("library", 201)[0]["who"], "Rhett Butler")
        self.assertEqual(self.lines("library", 203)[0]["who"], "Rhett Butler")
        nulls = [b for b in lines if b["who"] is None]
        self.assertLessEqual(len(nulls) / len(lines), 0.40)

    def test_hall(self):
        for p in (227, 235):
            self.assertEqual(self.lines("hall", p)[0]["who"], "Honey Wilkes")
        self.assertEqual(self.lines("hall", 248)[0]["who"], "Charles Hamilton")
        self.assertEqual(self.lines("hall", 250)[0]["who"], "Charles Hamilton")

    def test_long_narration_split(self):
        big = " ".join(["alpha,"] * 59 + ["omega."])
        small = " ".join(["beta"] * 29 + ["end."])
        para = big + " " + small + " " + small
        self.assertEqual(len(para.split()), 120)
        scene = {"id": "x", "paras": [0, 1], "cast": ["A"], "aliases": {}}
        book = {"cast": {"A": {"sex": "man"}}}
        beats = B.parse_scene(para, scene, book)
        narr = [b for b in beats if b["kind"] == "narration"]
        self.assertGreaterEqual(len(narr), 3)
        for b in narr:
            self.assertLessEqual(len(b["text"].split()), 40)
        self.assertEqual(" ".join(b["text"] for b in narr).split(), para.split())

    def test_stats_cli(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        path = os.path.join(out, "s.json")
        rc = B.main([BOOK_DIR, "--scene", "library", "--out", path, "--stats"])
        self.assertEqual(rc, 0)
        with open(path) as f:
            data = json.load(f)
        self.assertEqual(data["scene"], "library")
        self.assertEqual(set(data), {"book", "chapter", "scene", "place", "cast", "beats", "warnings"})


class ValidationTest(unittest.TestCase):
    def _variant(self, mutate):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        shutil.copy(os.path.join(BOOK_DIR, "ch06.txt"), d)
        with open(os.path.join(BOOK_DIR, "book.json")) as f:
            data = json.load(f)
        mutate(data)
        with open(os.path.join(d, "book.json"), "w") as f:
            json.dump(data, f)
        return d

    def test_alias_not_in_cast(self):
        d = self._variant(lambda b: b["chapters"][0]["scenes"][1]["aliases"].update({"Zed": "Zed Nobody"}))
        with self.assertRaises(ValueError) as cm:
            B.load_book(d)
        self.assertIn("Zed", str(cm.exception))

    def test_overlap(self):
        def m(b):
            b["chapters"][0]["scenes"][1]["paras"] = [130, 218]
        with self.assertRaises(ValueError):
            B.load_book(self._variant(m))

    def test_out_of_range(self):
        def m(b):
            b["chapters"][0]["scenes"][2]["paras"] = [218, 281]
        with self.assertRaises(ValueError) as cm:
            B.load_book(self._variant(m))
        self.assertIn("paras", str(cm.exception))

    def test_bad_voice(self):
        def m(b):
            b["cast"]["Rhett Butler"]["voice"] = "nope"
        with self.assertRaises(ValueError) as cm:
            B.load_book(self._variant(m))
        self.assertIn("voice", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
