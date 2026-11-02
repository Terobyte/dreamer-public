"""`story` gives every book line its delivery (dream/voice_tone): Mama's "Wake up" is voiced warm, not flat
(Koshakan, Nov 2). The tone answer is cached next to the score, so a rebuild makes no call.
usage: cd h0 && python3 -m unittest -q make.test_story_tones
"""
import json
import sys
import tempfile
import types
import unittest
from unittest import mock

from .test_story_places import _ctx

SCORE = {"scene": "s1", "warnings": [], "beats": [
    {"id": 0, "kind": "narration", "text": "Mama bent down and whispered:"},
    {"id": 1, "kind": "line", "who": "Mama", "text": "Wake up."}]}


def _run(ctx, answers):
    book = types.ModuleType("book")
    book.score_scene = lambda *a, **k: json.loads(json.dumps(SCORE))
    calls = []

    def director(prompt):
        calls.append(prompt)
        return answers.pop(0) if answers else ""
    with mock.patch.dict(sys.modules, {"book": book}):
        from make import story
        with mock.patch.object(story, "_spark_director", lambda ctx: director):
            story.run_story(ctx)
    return json.loads((ctx.out / "score.json").read_text()), calls


class StoryTones(unittest.TestCase):
    def test_live_story_writes_line_tones(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _ctx(tmp, world=False)
            ctx.params = {}
            score, calls = _run(ctx, [json.dumps({"tones": [{"id": 1, "tone": "whispering, warm"}]})])
            self.assertEqual(score["beats"][1].get("tone"), "whispering, warm")
            self.assertTrue(list(ctx.out.glob("tone-*.json")))

    def test_previous_story_tone_cache_makes_no_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _ctx(tmp, world=False)
            ctx.params = {}
            _run(ctx, [json.dumps({"tones": [{"id": 1, "tone": "soft"}]})])
            for f in ctx.out.glob("tone-*.json"):
                (ctx.run_dir / "story" / f.name).write_text(f.read_text())
                f.unlink()
            score, calls = _run(ctx, [])
            self.assertEqual(calls, [])
            self.assertEqual(score["beats"][1].get("tone"), "soft")

    def test_fake_story_has_no_tones(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _ctx(tmp, world=False)
            score, calls = _run(ctx, [])
            self.assertNotIn("tone", score["beats"][1])
            self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
