"""dub.py: a text-only run voiced and drawn afterwards, each speaker in the voice
the scene gives them. Offline: fake Fish and fake pictures.
usage: cd h0/dream && python3 -m unittest -q test_dub
"""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import dub
import sim
from images import Images, fake_transport as fake_image
from voice import Voice, fake_transport as fake_voice


class DubTest(unittest.TestCase):

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.addCleanup(sim.use_scene, "start")
        self.run_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.run_dir, True)
        rows = [{"seq": 1, "t": 0.0, "type": "snapshot"},
                {"seq": 2, "t": 1.0, "type": "line", "text": "[flat] Who are you?",
                 "who": "Scarlett", "role": "hero"},
                {"seq": 3, "t": 2.0, "type": "line", "text": "[lazy] Nobody.",
                 "who": "Rhett", "role": "actor"},
                {"seq": 4, "t": 3.0, "type": "event", "what": "x"}]
        with open(os.path.join(self.run_dir, "log.jsonl"), "w") as f:
            f.write("".join(json.dumps(r) + "\n" for r in rows))
        self.labels = []
        real = Voice(transport=fake_voice)
        self.voice = mock.Mock(wraps=real)
        self.voice.synthesize.side_effect = lambda text, label, path: (
            self.labels.append(label) or real.synthesize(text, label, path))

    def _log(self):
        with open(os.path.join(self.run_dir, "log.jsonl")) as f:
            return [json.loads(l) for l in f]

    def test_each_speaker_gets_the_scene_voice_and_faces_are_drawn(self):
        n, p = dub.dub(self.run_dir, "twelve_oaks", "A", voice=self.voice,
                       images=Images(transport=fake_image))
        self.assertEqual(n, 2)
        self.assertEqual(self.labels, ["scarlett", "rhett"])
        rows = self._log()
        lines = [r for r in rows if r["type"] == "line"]
        self.assertTrue(all(r["audio"].startswith("audio/") and r["dur"] > 0 for r in lines))
        pics = [r for r in rows if r["type"] == "image"]
        self.assertEqual(p, 7)  # the lawn + Scarlett + five actors
        self.assertEqual(pics[0]["kind"], "background")
        self.assertEqual(rows[1]["type"], "image", "pictures come right after the snapshot")
        self.assertEqual({r["who"] for r in pics[1:]},
                         {"Scarlett", "Rhett", "Ashley", "Gerald", "Stuart", "old man"})
        self.assertTrue(os.path.exists(os.path.join(self.run_dir, "log.jsonl.novoice")))

    def test_a_dubbed_run_is_left_alone(self):
        dub.dub(self.run_dir, "twelve_oaks", voice=self.voice, images=False)
        before = self._log()
        self.assertEqual(dub.dub(self.run_dir, "twelve_oaks", voice=self.voice), (0, 0))
        self.assertEqual(self._log(), before)

    def test_authored_scene_voices_come_from_its_voice_ids(self):
        with open(os.path.join(os.path.dirname(sim.__file__), "scenes", "roof.json")) as f:
            scene = json.load(f)
        scene["actors"][0]["voice"] = "cast_dan"
        scene["voice_ids"] = {"cast_dan": "d" * 32}
        hero, voices, looks, place, pool = dub.cast_of(scene, "A")
        self.assertEqual(hero, "Max")
        self.assertEqual(voices["Dan"], "cast_dan")
        self.assertEqual(pool["cast_dan"], "d" * 32)


if __name__ == "__main__":
    unittest.main()
