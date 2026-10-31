"""Jane Eyre ch. XIII book.json: stats thresholds, narrator_voice read by the sim."""
import os
import unittest

import book as bookmod
import sim

HERE = os.path.dirname(os.path.abspath(__file__))
JANE = os.path.join(HERE, "books", "jane-eyre")
GWTW = os.path.join(HERE, "books", "gwtw")


class JaneEyreBook(unittest.TestCase):
    def test_stats_thresholds(self):
        sc = bookmod.score_scene(JANE, "tea")
        st = bookmod.stats(sc)
        self.assertGreaterEqual(st["kinds"].get("line", 0), 20)
        self.assertLessEqual(st["unattributed_share"], 0.40)

    def test_cast_voices_and_aliases(self):
        b = bookmod.load_book(JANE)
        self.assertEqual(b["pov"], "Jane Eyre")
        self.assertEqual(b["narrator_voice"], "woman")
        self.assertEqual({k: v["voice"] for k, v in b["cast"].items()},
                         {"Jane Eyre": "woman", "Edward Rochester": "man",
                          "Mrs. Fairfax": "old_woman", "Adèle": "child"})
        al = bookmod.find_scene(b, "tea")[1]["aliases"]
        self.assertEqual(al["I"], "Jane Eyre")
        self.assertEqual(al["me"], "Jane Eyre")

    def test_sim_reads_narrator_voice(self):
        self.assertEqual(sim._load_book_plan(JANE)["narrator_voice"], "woman")
        self.assertEqual(sim._load_book_plan(GWTW)["narrator_voice"], "old_man")


if __name__ == "__main__":
    unittest.main()
