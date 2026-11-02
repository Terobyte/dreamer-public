"""N17: _book_step passes each speaker's own remarks into npc_start (and so into the line event)."""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import sim as S

HERE = os.path.dirname(os.path.abspath(__file__))
KOSHAKAN = os.path.join(HERE, "books", "koshakan")


class TestBookRemarks(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.tmp = tempfile.mkdtemp(prefix="book-remarks-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        S.use_scene("start")

    def test_every_speaker_gets_own_remarks_in_npc_start(self):
        beats = [
            {"id": 0, "kind": "line", "who": "Mama", "text": "Wake up.", "remarks": "stern"},
            {"id": 1, "kind": "line", "who": "Mirai", "text": "Five more minutes.", "remarks": ["sleepy", "tired"]},
            {"id": 2, "kind": "line", "who": "Mama", "text": "Now.", "remarks": None},
        ]
        score = [{"scene": "bedroom", "place": "bedroom", "cast": ["Mirai", "Mama"],
                  "start": [{"who": "Mirai", "place": "bed", "pose": "lie"}], "beats": beats}]
        path = os.path.join(self.tmp, "score.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(score, f)
        plan = S._load_book_plan(KOSHAKAN, ["bedroom"], path)
        S.use_scene(plan["scenes"][0]["dict"])
        sim = S.Sim(profile=None, fake=True, speed=1.0, outdir=self.tmp, book=plan, script=[])
        self.addCleanup(sim.close)
        seen = []
        real = sim.npc_start

        def spy(line, audio_seconds=None):
            seen.append(dict(line) if isinstance(line, dict) else line)
            return real(line, audio_seconds)

        with mock.patch.object(sim, "npc_start", side_effect=spy):
            for _ in range(len(beats)):
                sim._book_step()
                # a book line occupies the playback slot: end it so the next beat can start
                sim.active_line = None
        self.assertEqual(len(seen), 3)
        self.assertEqual(seen[0]["who"], "Mama")
        self.assertEqual(seen[0]["remarks"], "stern")
        self.assertEqual(seen[1]["who"], "Mirai")
        self.assertEqual(seen[1]["remarks"], ["sleepy", "tired"])
        self.assertEqual(seen[2]["who"], "Mama")
        self.assertIn("remarks", seen[2])
        self.assertEqual(seen[2]["remarks"], None)
        with open(os.path.join(self.tmp, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(x) for x in f if x.strip()]
        lines = [r for r in rows if r["type"] == "line"]
        by_text = {r.get("text"): r for r in lines}
        self.assertEqual(by_text["Wake up."]["remarks"], "stern")
        self.assertEqual(by_text["Five more minutes."]["remarks"], ["sleepy", "tired"])
        # _play_line drops None-valued keys: a beat without remarks emits a line without the key
        self.assertNotIn("remarks", by_text["Now."])


if __name__ == "__main__":
    unittest.main()
