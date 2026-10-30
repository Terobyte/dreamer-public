"""Phase 2.2 contract (spec 7.2 row 2.2): a safety phrase from the human stops the
dream. The clock, the lines, the director, fsm timers, events, pictures and TTS all
hold; only /continue lets the dream go on, with one soft note to every actor.
usage: cd h0/dream && python3 -m unittest test_phase2_safety -q
"""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import clock as clock_mod
import safety
import sim as sim_mod
from dialogue import Dialogue
from fake import FakeTransport
from sim import SOFT_NOTE, Sim, load_profile


class Mono:
    """A hand-driven time.monotonic: the pause test must own t0 as well, so it
    patches the clock module before Sim(...) builds its Clock."""

    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


class Stub:
    """A voice that counts calls and always fails: _start_line reads ok/pause only."""

    def __init__(self):
        self.calls = 0

    def synthesize(self, text, label, out_path):
        self.calls += 1
        return {"ok": False, "pause": 0.2}


def rows(root):
    with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class SafetyMatchTest(unittest.TestCase):
    def test_safety_match(self):
        self.assertEqual(safety.match("I WANT TO DIE"), "want to die")
        self.assertEqual(safety.match("  i   want\nto   die  tonight "), "want to die")
        self.assertEqual(safety.match("maybe i should kill myself"), "kill myself")
        self.assertEqual(safety.match("Я ХОЧУ УМЕРЕТЬ"), "хочу умереть")
        # a line about a song is not a cry for help (the whole point of a list)
        self.assertIsNone(safety.match("I'll kill this song"))
        self.assertIsNone(safety.match(""))
        self.assertIsNone(safety.match(None))
        for lang in ("en", "ru"):
            for phrase in safety.PHRASES[lang]:
                self.assertEqual(safety.match("well, " + phrase.upper() + "."), phrase)


class ContinueRouteTest(unittest.TestCase):
    def test_viewer_posts_continue(self):
        import server
        here = os.path.dirname(os.path.abspath(server.__file__))
        with open(os.path.join(here, "comic.html"), encoding="utf-8") as f:
            page = f.read()
        self.assertIn("fetch('/continue'", page)
        self.assertIn('"Content-Type": "application/json"', page)


class ClockPauseTest(unittest.TestCase):
    def test_clock_pause_resume(self):
        mono = Mono()
        with mock.patch.object(clock_mod.time, "monotonic", new=mono):
            c = clock_mod.Clock(speed=1.0)
            mono.t += 2.0
            before = c.now()
            c.pause()
            mono.t += 5.0
            self.assertAlmostEqual(c.now(), before, delta=1e-9)
            c.resume()
            self.assertAlmostEqual(c.now(), before, delta=1e-9)
            mono.t += 1.0
            self.assertAlmostEqual(c.now(), before + 1.0, delta=1e-9)


class SafetyPauseTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        sim_mod.use_scene("roof3")
        self.addCleanup(sim_mod.use_scene, "start")
        self.mono = Mono()
        self.enterContext(mock.patch.object(clock_mod.time, "monotonic", new=self.mono))
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.transport = FakeTransport(reply=lambda *a: "[flat] the wind moves.")
        dlg = Dialogue(load_profile("A"), transport=self.transport)
        self.sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(self.sim.close)
        self.assertTrue(self.sim.actors)

    def _step(self, n=1, dt=5.0):
        for _ in range(n):
            self.mono.t += dt
            self.sim._tick()
            self.sim._maybe_generate_line()
            self.sim._maybe_consult(-1e9)
            th = self.sim._gen_thread
            if th is not None and th.is_alive():
                th.join(2)

    def _quiet(self):
        """Let the dream really run, then land every worker so a baseline is a baseline."""
        self._step(6)
        self.assertTrue(self.transport.calls, "the dream never spoke, the baseline is empty")
        self.sim.director.wait(timeout=5)
        self.sim._drain_director()
        self.sim.memory.wait(timeout=5)

    def test_count_line_honors_pause(self):
        """7.2 row 2.2: `_count_line` checks the flag -- no count, no consult."""
        sim = self.sim
        sim.safety_paused = True
        before = sim.line_count
        with mock.patch.object(sim.director, "consult_async") as consult:
            for _ in range(8):
                sim._count_line()
        self.assertEqual(sim.line_count, before)
        consult.assert_not_called()

    def test_safety_pauses_everything(self):
        sim = self.sim
        self._quiet()
        calls, prompts = self.transport.calls, len(sim.director.prompts)
        state, t_paused = sim.fsm.state, sim.clock.now()
        n = len(rows(self.root))

        sim.human_say("i want to die")
        self.assertTrue(sim.safety_paused)
        new = rows(self.root)[n:]
        hit = [r for r in new if r["type"] == "safety_pause"]
        self.assertEqual(len(hit), 1, new)
        self.assertEqual(hit[0]["matched"], "want to die")
        self.assertIn("t", hit[0])
        self.assertFalse([r for r in new if r["type"] == "line_queued"])
        self.assertFalse([r for r in rows(self.root) if r["type"] == "line"
                          and r.get("turn_owner") == "human"])
        self.assertFalse([r for r in new if r["type"] == "input"])
        self.assertEqual(len(sim.director.prompts), prompts)
        self.assertIsNone(sim.next_line)

        n = len(rows(self.root))
        self._step(50)
        self.assertEqual(self.transport.calls, calls)
        self.assertEqual(len(sim.director.prompts), prompts)
        self.assertEqual(sim.fsm.state, state)
        self.assertAlmostEqual(sim.clock.now(), t_paused, delta=1e-9)
        for r in rows(self.root)[n:]:
            self.assertNotIn(r["type"], ("line", "event", "consult", "note", "image"))

    def test_safety_drops_input_while_paused(self):
        sim = self.sim
        sim.human_say("i want to die")
        n = len(rows(self.root))
        sim.human_say("hello")
        new = rows(self.root)[n:]
        dropped = [r for r in new if r["type"] == "input_dropped"]
        self.assertEqual(len(dropped), 1, new)
        self.assertEqual(dropped[0]["reason"], "safety")
        self.assertIn("t", dropped[0])
        self.assertFalse([r for r in new if r["type"] == "line_queued"])
        self.assertIsNone(sim.next_line)

    def test_safety_ignores_npc(self):
        sim = self.sim
        sim.npc_start({"who": sim.actors[0], "role": "actor",
                       "text": "the word suicide hung in the air", "remarks": []})
        self.assertFalse(sim.safety_paused)
        # a community tool posting for the human is human input, and it does pause
        sim.post_event({"source": "tool", "value": "i want to die"})
        self.assertTrue(sim.safety_paused)

    def test_safety_no_tts(self):
        sim = self.sim
        stub = Stub()
        sim._voice = stub
        sim.fake = False
        line = {"owner": "npc", "role": "actor", "who": sim.actors[0], "text": "a quiet line"}
        sim.human_say("i want to die")
        sim._start_line(dict(line))
        self.assertEqual(stub.calls, 0)
        sim.submit("continue")
        sim._drain_inbox()
        sim._start_line(dict(line))
        self.assertEqual(stub.calls, 1)

    def test_safety_input_not_in_memory(self):
        """2.2: a matched cry and anything typed after it stay out of the minds --
        the dream must not remember what it refused to play."""
        sim = self.sim
        sim.human_say("i want to die")
        sim.human_say("hello")
        sim.memory.wait(timeout=5)
        seen = [l["text"] for l in sim.memory.lines] + list(sim.memory.events)
        self.assertFalse([t for t in seen if "want to die" in t or "hello" in t], seen)

    def test_safety_holds_scene_events(self):
        """The pause holds the scene schedule too: a world event comes due only
        once the dream goes on again."""
        sim = self.sim
        sim._schedule = [{"t": 1.0, "what": "a gull screams", "who": "all",
                          "kind": "world"}]
        sim._fired = set()
        sim.scene_start = sim.clock.now()
        sim.human_say("i want to die")
        n = len(rows(self.root))
        self._step(12)
        self.assertFalse([r for r in rows(self.root)[n:] if r["type"] == "event"])
        sim.submit("continue")
        sim._drain_inbox()
        n = len(rows(self.root))
        self._step(2)
        fired = [r for r in rows(self.root)[n:] if r["type"] == "event"]
        self.assertEqual([r["what"] for r in fired], ["a gull screams"], fired)

    def test_safety_holds_pictures(self):
        """The picture gate is the flag: no background and no portrait is asked
        for while the dream is held."""
        sim = self.sim
        sim.fake = False
        sim._images = object()
        self.assertTrue(sim._media_live())
        sim.human_say("i want to die")
        self.assertFalse(sim._media_live())
        sim.submit("continue")
        sim._drain_inbox()
        self.assertTrue(sim._media_live())

    def test_continue_resumes_soft(self):
        sim = self.sim
        self._quiet()
        sim.human_say("i want to die")
        t_paused = sim.clock.now()
        self.mono.t += 30.0
        sim.submit("continue")
        sim._drain_inbox()
        self.assertFalse(sim.safety_paused)
        self.assertAlmostEqual(sim.clock.now(), t_paused, delta=1e-9)
        for a in sim.actors:
            self.assertEqual(sim._notes[a].count(SOFT_NOTE), 1)
        sim.submit("continue")
        sim._drain_inbox()
        for a in sim.actors:
            self.assertEqual(sim._notes[a].count(SOFT_NOTE), 1)
        # the dream goes on: a line is generated again
        n = len(rows(self.root))
        self._step(12)
        self.assertTrue([r for r in rows(self.root)[n:] if r["type"] == "line"])


if __name__ == "__main__":
    unittest.main()
