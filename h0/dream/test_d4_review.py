"""D4 review fixes: scene context after the walk, registry without a silent yard fallback,
steer keeps its own K/TTL beside the stall, silence -> out-of-turn consult before the bank."""

import tempfile
import unittest

from sim import Sim


def mk(**kw):
    return Sim(fake=True, outdir=tempfile.mkdtemp(), no_build=True, build_mode="cache",
               fsm_params={"build": 1}, scene_world="koshakan", **kw)


class ReviewTest(unittest.TestCase):
    def test_walk_loads_destination_room_and_fsm_idle(self):
        s = mk()
        try:
            old = list(s.scene["objects"])
            s.clock.now = lambda: 0
            s._start_scene_build({"id": "x", "scene_id": "koshakan_shop"})
            s.clock.now = lambda: 1
            for e in s.fsm.tick(1):
                s._emit(e)
            self.assertEqual(s.place, "bathroom")
            self.assertEqual(s.fsm.state, "idle")
            self.assertNotEqual(s.scene["objects"], old)
            self.assertIn("bathroom", s.scene["objects"])
        finally:
            s.close()

    def test_unknown_scene_world_refuses(self):
        with self.assertRaises(ValueError):
            Sim(fake=True, outdir=tempfile.mkdtemp(), scene_world="mismatch")

    def test_no_scene_world_has_no_scenes(self):
        s = Sim(fake=True, outdir=tempfile.mkdtemp())
        try:
            self.assertEqual(s.scene_registry, {})
        finally:
            s.close()

    def test_steer_keeps_own_ttl_beside_stall(self):
        s = mk()
        try:
            s._steer[None] = {"id": "a", "topic": "сестра", "left": 6, "until": s.ideas.wall() + 60}
            s.clock.now = lambda: 0
            s._start_scene_build({"id": "x", "scene_id": "koshakan_shop"})
            self.assertEqual(s._steer[None]["left"], 6)
            self.assertLess(s._steer[None]["until"], float("inf"))
            self.assertTrue(s._stall_topic)
        finally:
            s.close()

    def _building(self, in_flight):
        s = mk()
        s.fsm.state = "building"
        s._cache_build = {"id": "x", "bridge": "door", "destination": "bathroom",
                          "stall_bank": ["bank line"], "i": 0}
        s.director.in_flight = in_flight
        calls = []
        s.director.consult_async = lambda *a, **k: calls.append(1)
        return s, calls

    def test_silence_asks_director_first(self):
        s, calls = self._building(False)
        try:
            s._silent_since = 0
            s._stall_step(5)
            self.assertEqual(len(calls), 1)
            self.assertIsNone(s.next_line or s.active_line)
        finally:
            s.close()

    def test_two_empty_consults_then_bank(self):
        s, calls = self._building(False)
        try:
            for t in (5, 10):
                s._silent_since = t - 5
                s._stall_step(t)
            s._silent_since = 10
            s._stall_step(15)
            self.assertEqual(len(calls), 2)
            self.assertTrue(s.next_line or s.active_line)
        finally:
            s.close()

    def test_stuck_director_bank_at_once(self):
        s, calls = self._building(True)
        try:
            s._silent_since = 0
            s._stall_step(5)
            self.assertEqual(calls, [])
            self.assertTrue(s.next_line or s.active_line)
        finally:
            s.close()


if __name__ == "__main__":
    unittest.main()
