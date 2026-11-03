"""D4 round-5 blockers (host takeover after the fuse): F17 an endless cache build,
F18 the hero's reply after an abort lost behind a long NPC line, F19 run() hanging
on a consult the sim already gave up on."""

import tempfile
import threading
import unittest

from fsm import BuildFSM
from sim import Sim


def mk(build=45):
    return Sim(fake=True, outdir=tempfile.mkdtemp(), no_build=True, build_mode="cache",
               fsm_params={"build": build}, scene_world="koshakan")


class F17EndlessBuild(unittest.TestCase):
    def test_cache_build_refuses_inf_and_nan(self):
        for bad in (float("inf"), float("nan")):
            with self.assertRaises(ValueError):
                BuildFSM(["door"], no_build=True, build_mode="cache", params={"build": bad})


class F18HeroAfterAbort(unittest.TestCase):
    def test_hero_speaks_within_20s_even_behind_a_long_npc_line(self):
        s = mk()
        try:
            t = [0.0]
            s.clock.now = lambda: t[0]
            s._start_scene_build({"id": "x", "scene_id": "koshakan_shop"})
            s.active_line = {"owner": "npc", "who": "Squidward", "role": "actor", "text": "long line"}
            s._line_started_at, s._line_duration = 0.0, 30.0
            started = []
            s._start_line = lambda line, audio_seconds=None: started.append((t[0], line))
            s.abort_build("test")
            for i in range(41):
                t[0] = i * 0.5
                s._stall_step(t[0])
                s._cycle_line()
            hero = [(at, ln) for at, ln in started if ln.get("role") == "hero"]
            self.assertTrue(hero, "the hero never spoke after the abort")
            self.assertLessEqual(hero[0][0], 20.0)
        finally:
            s.active_line = None
            s.close()


class F19RunAfterAbandon(unittest.TestCase):
    def test_run_returns_without_the_abandoned_consult(self):
        s = mk()
        gate = threading.Event()
        s.director._next_decision = lambda ticket, prompt: (gate.wait(), {})[1]
        try:
            t = [0.0]
            s.clock.now = lambda: t[0]
            s._start_scene_build({"id": "x", "scene_id": "koshakan_shop"})
            self.assertIsNotNone(s.director.consult_async(0.0, events=[{"t": 0.0, "type": "consult_due"}]))
            t[0] = 21.0
            s._stall_step(21.0)
            done = threading.Event()
            th = threading.Thread(target=lambda: (s.run(max_seconds=0), done.set()), daemon=True)
            th.start()
            self.assertTrue(done.wait(15), "run() waited for the abandoned consult")
        finally:
            gate.set()
            s.close()


if __name__ == "__main__":
    unittest.main()
