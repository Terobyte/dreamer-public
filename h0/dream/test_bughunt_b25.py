# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
import book as bk


def test_inter_quote_tag_not_duplicated_as_narration():
    scene = {"cast": ["India"], "paras": [0, 1], "aliases": {"India": ["India"]}}
    book = {"cast": {"India": {"sex": "woman"}}, "title": "t"}
    st = bk._State(scene, book)
    para = '"War!" shouted India, cupping her hand to his ear. "They want to fight the Yankees!"'
    beats = bk._para_beats(st, 0, para)
    line = next(x for x in beats if x["kind"] == "line")
    assert "shouted India" in line["tag"]
    narrs = [x for x in beats if x["kind"] == "narration"]
    # expected: nothing after the last quote -> no narration beat; bug: inter-quote remark leaks into narration
    assert narrs == [], f"tag leaked into narration: {narrs}"


class BughuntB25(unittest.TestCase):
    def test_b25(self):
        test_inter_quote_tag_not_duplicated_as_narration()
