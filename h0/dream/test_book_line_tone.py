"""A book line is voiced with its delivery: drama-3 plays "[softly, warmly] Wake up" with feeling and reads
bare text flat (Koshakan, Nov 2: Mama sounded dry in the engine film; the warm take of Nov 1 lived only in the
hand-made demo). The subtitle stays the book's text, without the brackets.
usage: cd h0/dream && python3 -m unittest -q test_book_line_tone
"""
import copy
import json
import os
import tempfile
import unittest

import sim as S
from test_book_narration_voice import _OkVoice

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK = os.path.join(HERE, "books", "koshakan")


def _score_with_tone():
    plan = S._load_book_plan(BOOK, ["bedroom"])
    beats = copy.deepcopy(plan["scenes"][0]["beats"])
    for b in beats:
        if b["kind"] == "line" and b.get("who") == "Mama":
            b["tone"] = "softly, warmly, smiling"
    return {"scene": "bedroom", "beats": beats}


class BookLineToneTest(unittest.TestCase):
    def tearDown(self):
        S.use_scene("start")

    def _rows(self, score):
        plan = S._load_book_plan(BOOK, ["bedroom"], score)
        S.use_scene(plan["scenes"][0]["dict"])
        d = tempfile.mkdtemp()
        sim = S.Sim(profile=None, fake=True, speed=1000.0, outdir=d, book=plan, script=[])
        sim.fake = False
        voice = _OkVoice()
        sim._voice = voice
        sim._audio_dir = d
        try:
            for _ in range(3000):
                sim._tick()
                sim.clock.real_sleep(0.0005)
                if sim.book["over"]:
                    break
        finally:
            sim.close()
        with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
            return [json.loads(l) for l in f if l.strip()], voice

    def test_line_is_voiced_with_its_tone_subtitle_stays_plain(self):
        rows, voice = self._rows(_score_with_tone())
        said = [(lab, t) for lab, t in voice.calls if "Koshakanym" in t]
        self.assertEqual(said, [("koshakan_mama", "[softly, warmly, smiling] Wake up, Koshakanym.")])
        lines = [r for r in rows if r["type"] == "line" and r.get("who") == "Mama"]
        self.assertEqual([r["text"] for r in lines], ["Wake up, Koshakanym."])

    def test_line_without_tone_is_voiced_as_written(self):
        rows, voice = self._rows(None)
        said = [t for _, t in voice.calls if "Koshakanym" in t]
        self.assertEqual(said, ["Wake up, Koshakanym."])


if __name__ == "__main__":
    unittest.main()
