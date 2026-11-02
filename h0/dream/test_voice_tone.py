"""voice_tone.add_tones: one director call per scene gives every book line its delivery (beat["tone"]), which
sim voices as a drama-3 [direction]. Bare text reads flat (Koshakan, Nov 2).
usage: cd h0/dream && python3 -m unittest -q test_voice_tone
"""
import json
import tempfile
import unittest

import voice_tone as VT

SCORE = {"scene": "bedroom", "beats": [
    {"id": 0, "kind": "narration", "text": "Mama bent down and whispered, warm against her ear:"},
    {"id": 1, "kind": "line", "who": "Mama", "text": "Wake up, Koshakanym."},
    {"id": 2, "kind": "line", "who": "Mirai", "text": "Five more minutes!"},
]}


class AddTonesTest(unittest.TestCase):
    def test_each_line_gets_its_tone_narration_untouched(self):
        prompts = []

        def director(p):
            prompts.append(p)
            return json.dumps({"tones": [{"id": 1, "tone": "[whispering, warm, tender]"},
                                         {"id": 2, "tone": "sleepy, grumbling"},
                                         {"id": 0, "tone": "loud"}, {"id": 9, "tone": "x"}]})
        out, warns = VT.add_tones(SCORE, director)
        tones = {b["id"]: b.get("tone") for b in out["beats"]}
        self.assertEqual(tones, {0: None, 1: "whispering, warm, tender", 2: "sleepy, grumbling"})
        self.assertEqual(len(prompts), 1)
        # the model sees the narration around the line: "whispered" is the cue for Mama's delivery
        self.assertIn("whispered, warm against her ear", prompts[0])
        self.assertIn("Wake up, Koshakanym.", prompts[0])
        self.assertNotIn("tone", SCORE["beats"][1])  # the input score is not mutated

    def test_broken_answer_leaves_lines_as_written(self):
        out, warns = VT.add_tones(SCORE, lambda p: "not json")
        self.assertFalse(any(b.get("tone") for b in out["beats"]))
        self.assertTrue(warns)

    def test_answer_is_cached_by_the_lines(self):
        d = tempfile.mkdtemp()
        calls = []

        def director(p):
            calls.append(p)
            return json.dumps({"tones": [{"id": 1, "tone": "soft"}]})
        a, _ = VT.add_tones(SCORE, director, cache_dir=d)
        b, _ = VT.add_tones(SCORE, director, cache_dir=d)
        self.assertEqual(len(calls), 1)
        self.assertEqual(a, b)

    def test_scene_without_lines_makes_no_call(self):
        score = {"scene": "s", "beats": [{"id": 0, "kind": "narration", "text": "Night."}]}
        out, warns = VT.add_tones(score, lambda p: self.fail("called"))
        self.assertEqual(out, score)


if __name__ == "__main__":
    unittest.main()
