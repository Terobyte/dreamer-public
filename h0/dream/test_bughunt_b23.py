# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
from fsm import check_scene


def test_check_scene_rejects_actor_without_name():
    voices = ["man", "woman"]
    ns = {"actors": [{"voice": "man"}], "objects": ["o1", "o2", "o3", "o4", "o5"]}
    assert check_scene(ns, voices) == ("next_scene", "bad_type")


class BughuntB23(unittest.TestCase):
    def test_b23(self):
        test_check_scene_rejects_actor_without_name()
