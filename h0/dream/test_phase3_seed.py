"""3.3: a dream seeded by one line of text -- the director builds the first scene.
usage: cd h0/dream && python3 -m unittest -q test_phase3_seed
"""

import io
import json
import os
import tempfile
import unittest
from unittest import mock

import director
import sim
from fake import FakeTransport


def _reply(objects=("mirror", "button panel", "grille", "handrail", "hatch")):
    return json.dumps({
        "destination": "a cold lift",
        "why": "he never finished the ride",
        "next_scene": {
            "objects": list(objects),
            "actors": [{"name": "Stranger", "voice": "man",
                        "persona": "wants the doors open before anyone speaks"}],
            "events": [{"t": 0, "what": "the lift jolts", "who": "all", "kind": "world"}],
            "goals": [],
            "hero_reason": "you pressed the button and the cage stopped",
        },
    })


class SeedTest(unittest.TestCase):

    def setUp(self):
        self.addCleanup(sim.use_scene, "start")

    def test_seed_starts_scene(self):
        seen = {}
        tmp = tempfile.mkdtemp()

        def fake_run(**kw):
            seen.update(kw)
            seen["scene"] = dict(sim.START_SCENE)
            seen["place"] = sim.START_PLACE
            log = os.path.join(tmp, "log.jsonl")
            with open(log, "w", encoding="utf-8") as f:
                f.write("")
            return tmp, log

        with mock.patch.object(sim, "SEED_TRANSPORT", FakeTransport([_reply()])), \
                mock.patch.object(sim, "run", fake_run):
            with self.assertRaises(SystemExit):
                sim.main(["--seed", "two strangers stuck in a lift", "--fake"])
        self.assertEqual(seen["place"], "a cold lift")
        self.assertIn("mirror", seen["scene"]["objects"])
        self.assertEqual(seen["scene"]["actors"], ["Stranger"])
        self.assertEqual(seen["scene"]["events"], [])
        labels = [e.get("label") for e in seen["first_events"]]
        self.assertEqual(labels, ["seed"])
        self.assertEqual(seen["first_events"][0]["type"], "consult")

    def test_seed_no_profile_file(self):
        import builtins
        real_open = builtins.open
        opened = []

        def recording_open(path, *a, **kw):
            opened.append(str(path))
            return real_open(path, *a, **kw)

        tmp = tempfile.mkdtemp()
        with mock.patch("builtins.open", recording_open):
            s = sim.Sim(fake=True, profile=None, outdir=tmp)
        s.close()
        self.assertEqual([p for p in opened if "profiles" + os.sep in p], [])

    def test_seed_bad_director(self):
        short = _reply(objects=("mirror", "grille"))  # below SCENE_OBJECTS_RANGE
        err = io.StringIO()
        with mock.patch.object(sim, "SEED_TRANSPORT", FakeTransport([short, short])), \
                mock.patch("sys.stderr", err):
            with self.assertRaises(SystemExit) as cm:
                sim.main(["--seed", "a lift that never arrives", "--fake"])
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("seed: director failed", err.getvalue())

    def test_seed_fake_no_transport(self):
        err = io.StringIO()
        calls = mock.Mock(side_effect=AssertionError("no paid call on a fake seed"))
        with mock.patch.object(sim, "SEED_TRANSPORT", None), \
                mock.patch.object(director, "llm_call", calls), \
                mock.patch("sys.stderr", err):
            with self.assertRaises(SystemExit) as cm:
                sim.main(["--seed", "x", "--fake"])
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("seed: --fake needs a transport", err.getvalue())
        self.assertEqual(calls.call_count, 0)

    def test_seed_and_profile_conflict(self):
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            with self.assertRaises(SystemExit) as cm:
                sim.main(["--seed", "x", "--profile", "A", "--fake"])
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("--profile", err.getvalue())

    def test_seed_serve_run_uses_label(self):
        # F1: a seeded --serve run has profile None; the viewer run name must
        # resolve to the created seed/<run> dir, not None/<run>.
        import server
        import shutil

        class FakeSim:
            def __init__(self, **kw):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def run(self, **kw):
                pass

        seen = {}

        class FakeViewer:
            def __init__(self, sim=None, run=None, **kw):
                self.run = run
                seen["run"] = run

            def start(self, serve):
                return 1

            def stop(self):
                pass

        with mock.patch.object(sim, "Sim", FakeSim), \
                mock.patch.object(server, "Viewer", FakeViewer):
            outdir, _ = sim.run(profile=None, label="seed", fake=True,
                                max_transitions=0, max_seconds=0.01, serve=1)
        self.addCleanup(shutil.rmtree, outdir, True)
        self.assertTrue(str(seen.get("run")).startswith("seed/"), seen)


class SeedSceneTest(unittest.TestCase):

    def test_two_attempts_then_none(self):
        bad = _reply(objects=("mirror", "grille"))
        t = FakeTransport([bad, bad, _reply()])
        self.assertIsNone(director.seed_scene("a lift", t))
        self.assertEqual(t.calls, 2)

    def test_second_attempt_wins(self):
        t = FakeTransport(["not json at all", _reply()])
        d = director.seed_scene("a lift", t)
        self.assertEqual(d["destination"], "a cold lift")
        self.assertEqual(t.calls, 2)

    def test_empty_destination_rejected(self):
        # F2: no silent "somewhere" fallback; empty destination fails the attempt.
        import json as _json
        bad = _json.loads(_reply())
        bad["destination"] = "   "
        bad_txt = _json.dumps(bad)
        t = FakeTransport([bad_txt, bad_txt, _reply()])
        self.assertIsNone(director.seed_scene("a lift", t))
        self.assertEqual(t.calls, 2)


if __name__ == "__main__":
    unittest.main()
