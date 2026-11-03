"""D4: a cache build with next_scene None (room already in the dist) leaves the
FSM idle after walk_through, so later scene ideas still pass the idle check."""
import tempfile
import unittest
from unittest import mock
from sim import Sim


class IdleAfterShopTest(unittest.TestCase):
    def test_next_scene_none_returns_fsm_to_idle(self):
        root = tempfile.mkdtemp()
        s = Sim(profile="A", fake=True, speed=1.0, outdir=root, no_build=True,
                build_mode="cache", fsm_params={"build": 1},
                scene_world="koshakan")
        self.addCleanup(s.close)
        self.enterContext(mock.patch.object(s.director, "consult_async"))
        t = [0.0]
        s.clock.now = lambda: t[0]
        s.fsm.new_scene(0.0, s.fsm.objects)
        s.cleaner = lambda raw: {"clean": raw, "intent": "scene", "confidence": 0.9}
        s.post_idea({"kind": "idea", "id": "x", "source": "operator",
                     "value": "внутри магазина, начни строить сейчас"})
        s._idea_step()
        t[0] = 1.0
        for e in s.fsm.tick(1.0):
            s._emit(e)
        # after ready -> door open handler runs walk_through + _apply_transition
        self.assertEqual(s.place, "bathroom")
        self.assertEqual(s.fsm.state, "idle",
                         "F1: FSM stuck in %s with next_scene None" % s.fsm.state)


if __name__ == "__main__":
    unittest.main()
