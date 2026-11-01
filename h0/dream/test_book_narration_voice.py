"""Book narration is voiced: a narrator beat goes to TTS with the book's narrator voice and the
narrator event carries the audio, so the stage plays it (Koshakan, Nov 1: the whole closed-caption
track of a book was silent, only character lines had sound).
usage: cd h0/dream && python3 -m unittest -q test_book_narration_voice
"""
import json
import os
import tempfile
import unittest
import wave

import sim as S

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK = os.path.join(HERE, "books", "koshakan")


class _OkVoice:
    def __init__(self):
        self.calls = []

    def synthesize(self, text, label, path):
        self.calls.append((label, text))
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(8000)
            w.writeframes(b"\0\0" * 8000 * 3)  # 3 s
        return {"ok": True, "audio": path, "pause": 3.0, "seconds": 3.0, "diagnostic": None}


def _book_sim(voice):
    plan = S._load_book_plan(BOOK, ["bedroom"])
    S.use_scene(plan["scenes"][0]["dict"])
    d = tempfile.mkdtemp()
    sim = S.Sim(profile=None, fake=True, speed=1000.0, outdir=d, book=plan, script=[])
    sim.fake = False  # the offline flip idiom (test_media._live_sim)
    sim._voice = voice
    sim._audio_dir = d
    return sim, plan, d


class BookNarrationVoiceTest(unittest.TestCase):
    def tearDown(self):
        S.use_scene("start")

    def _run(self, voice, ticks=3000):
        sim, plan, d = _book_sim(voice)
        try:
            for _ in range(ticks):
                sim._tick()
                sim.clock.real_sleep(0.0005)
                if sim.book["over"]:
                    break
        finally:
            sim.close()
        with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f if l.strip()]
        return rows, plan, d

    def test_narration_beat_is_voiced_with_narrator_voice(self):
        voice = _OkVoice()
        rows, plan, d = self._run(voice)
        narr = [r for r in rows if r["type"] == "narrator" and r.get("cause") == "book"]
        self.assertTrue(narr)
        self.assertTrue(all(r.get("audio") for r in narr), narr[:2])
        for r in narr:
            self.assertTrue(os.path.isfile(os.path.join(d, r["audio"])))
            self.assertEqual(r.get("dur"), 3.0)
        labels = {lab for lab, text in voice.calls if any(text == r["text"] for r in narr)}
        self.assertEqual(labels, {plan["narrator_voice"]})

    def test_fake_sim_stays_silent(self):
        plan = S._load_book_plan(BOOK, ["bedroom"])
        out, log = S.run(book=BOOK, fake=True, speed=1000, scenes=["bedroom"])
        with open(log, encoding="utf-8") as f:
            rows = [json.loads(l) for l in f if l.strip()]
        narr = [r for r in rows if r["type"] == "narrator" and r.get("cause") == "book"]
        self.assertTrue(narr)
        self.assertFalse(any(r.get("audio") for r in narr))


if __name__ == "__main__":
    unittest.main()
