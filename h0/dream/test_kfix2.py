"""Red tests for the K-block review findings F17-F21.
usage: cd h0/dream && python3 -m unittest -q test_kfix2
"""
import copy
import json
import os
import re
import unittest

import book as B
import sim as S

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK = os.path.join(HERE, "books", "gwtw")


class FixTest2(unittest.TestCase):
    def tearDown(self):
        S.use_scene("start")

    def test_f17_prompt_whisper_is_fixed_in_viewport(self):
        with open(os.path.join(HERE, "comic.html"), encoding="utf-8") as f:
            html = f.read()
        body = html[html.index("function promptTake"):]
        body = body[:body.index("\n}\n")]
        self.assertIn("position:fixed", body.replace(" ", ""))

    def test_f18_same_para_narration_names_next_speaker(self):
        scene = {"id": "x", "paras": [0, 3], "cast": ["Alice A", "Bob B"],
                 "aliases": {"Alice": "Alice A", "Bob": "Bob B"}}
        book = {"cast": {"Alice A": {"sex": "woman"}, "Bob B": {"sex": "man"}}}
        text = ('"Hi there," said Bob. Alice smiled warmly across the room.\n\n'
                'The wind blew over the lawn for a while.\n\n'
                '"Go now, quickly, please, friend."')
        lines = [b for b in B.parse_scene(text, scene, book) if b["kind"] == "line"]
        self.assertEqual(lines[0]["who"], "Bob B")
        self.assertEqual(lines[1]["who"], "Alice A")

    def test_f19_score_scene_unknown_to_book(self):
        score = copy.deepcopy(B.score_scene(BOOK, "library"))
        score["scene"] = "nowhere"
        with self.assertRaises(ValueError):
            S._load_book_plan(BOOK, ["nowhere"], score)

    def test_f20_split_nearest_to_forty(self):
        words = [f"w{i}" for i in range(1, 71)]
        words[38] += ","  # comma after the 39th word
        chunks = B._split_long(" ".join(words))
        self.assertEqual(len(chunks[0].split()), 40)
        self.assertEqual(" ".join(chunks).split(), " ".join(words).split())

    def test_f21_explicit_start_is_a_scene_id(self):
        with self.assertRaises(SystemExit) as cm:
            S.main(["--book", BOOK, "--scene", "start", "--fake", "--speed", "50"])
        self.assertEqual(cm.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
