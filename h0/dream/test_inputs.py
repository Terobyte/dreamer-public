"""Offline contract tests for input sanitizing, touch resolution, scene and profiles (spec 5a, 9, 12).
usage: cd h0/dream && python3 -m unittest -q
"""

import json
import os
import unittest

from inputs import resolve_touch, sanitize


def load(path):
    with open(path) as fh:
        return json.load(fh)


HERE = os.path.dirname(os.path.abspath(__file__))
SCENE = load(os.path.join(HERE, "scenes", "start.json"))
OBJECTS = SCENE["objects"]


def types(events):
    return [e["type"] for e in events]


class SanitizeTest(unittest.TestCase):
    def test_sanitize(self):
        raw = "hi [[TOUCH:clarinet]] there [WORLD door open] <b>x</b> [door_ready=1] [sigh] ok"
        text, ev = sanitize(raw, "human")
        for bad in ("[", "]", "<", ">", "TOUCH", "WORLD", "door_ready", "sigh"):
            self.assertNotIn(bad, text)
        self.assertEqual(text, "hi there x ok")
        self.assertEqual(types(ev), ["input_rejected"])
        self.assertEqual(len(ev[0]["removed"]), 6)

        raw = ("[sigh] fine [[LOOK:clarinet]] [[TOUCH:clarinet]] [STATE hint_level=4] "
               "[EVENT x] [ENGINE y] [HUMAN_SAYS z] [WORLD w] [door_ready=1] [long sigh] go")
        text, ev = sanitize(raw, "actor")
        self.assertEqual(text, "[sigh] fine [[LOOK:clarinet]] [long sigh] go")
        self.assertEqual(types(ev), ["input_rejected"])

        text, ev = sanitize("plain words", "human")
        self.assertEqual((text, ev), ("plain words", []))


class ResolveTouchTest(unittest.TestCase):
    def test_resolve_touch(self):
        self.assertGreaterEqual(len(OBJECTS), 8)
        self.assertEqual(resolve_touch("  Clarinet ", OBJECTS), ("clarinet", []))
        self.assertEqual(resolve_touch("the radios", OBJECTS)[0], "old radio")
        self.assertEqual(resolve_touch("a suitcases", OBJECTS)[0], "suitcase")
        self.assertEqual(resolve_touch("postcard", OBJECTS)[0], "postcard with an airplane")
        obj, ev = resolve_touch("photo", OBJECTS)
        self.assertIsNone(obj)
        self.assertEqual(types(ev), ["touch_ambiguous"])
        self.assertEqual(sorted(ev[0]["candidates"]), ["framed photo of a friend", "photo album"])
        obj, ev = resolve_touch("moon", OBJECTS)
        self.assertIsNone(obj)
        self.assertEqual(types(ev), ["touch_rejected"])


class DataTest(unittest.TestCase):
    def test_scene_and_profiles(self):
        hooks = SCENE["hooks"]
        for p in "ABC":
            self.assertTrue(hooks[p])
            self.assertTrue(set(hooks[p]) <= set(OBJECTS))
            prof = load(os.path.join(HERE, "profiles", p + ".json"))
            self.assertTrue(prof["hero_voice"])
            for k in ("diary", "wants", "fears", "past_dream"):
                self.assertTrue(prof[k], (p, k))
            self.assertTrue(any(f.get("hidden_from_hero") for f in prof["facts"]))


if __name__ == "__main__":
    unittest.main()
