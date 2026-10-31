"""B62: a free-mode actor line without "voice"/"actor" keys must be voiced by its
own actor, not by actors[0] (the hero is listed first in a book-loaded run).
usage: cd h0/dream && python3 -m unittest -q test_bugs_voice
"""
import os
import tempfile
import unittest
from unittest import mock

import sim as S
from dialogue import Dialogue
from fake import FakeTransport
import random

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK = os.path.join(HERE, "..", "squid_live", "book")
REPLY = "[warm] Let us talk about something else entirely."


class _RecordingVoice:
    def __init__(self):
        self.labels = []

    def synthesize(self, text, label, path):
        self.labels.append(label)
        return {"ok": False, "pause": 0.5}


class FreeActorVoiceTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))

    def tearDown(self):
        S.use_scene("start")  # book runs replace the module-level opening scene

    def test_B62_free_actor_line_uses_its_own_voice(self):
        p = S._load_book_plan(BOOK, ["squid_house", "conch_street"],
                              os.path.join(BOOK, "score.json"))
        S.use_scene(p["scenes"][0]["dict"])
        s = S.Sim(profile=None, fake=True, outdir=tempfile.mkdtemp(), book=p, script=[])
        self.addCleanup(s.close)
        dlg = Dialogue(S.load_profile(None), transport=FakeTransport(reply=lambda *a: REPLY),
                       rng=random.Random(0))
        dlg.background = False
        s.go_freestyle(dialogue=dlg)
        self.assertEqual(s.status()["mode"], "free")

        voice = _RecordingVoice()
        s.fake = False
        s._voice = voice
        s.logger = s.logger or mock.Mock()
        self.enterContext(mock.patch.object(s, "_budget_ok", return_value=True))

        s._start_line({"who": "Squidward", "role": "actor", "owner": "npc",
                       "text": "Who ordered the seaweed?"})

        self.assertEqual(voice.labels, ["man"])


if __name__ == "__main__":
    unittest.main()
