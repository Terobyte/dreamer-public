"""D4 (c): a scene idea fires only when the entry names a bridge AND a destination.

A registry entry with a bridge but no destination must keep the idea waiting
(FSM stays idle, no build starts) instead of firing into a `goto None`.
"""
import tempfile
import unittest
from unittest import mock

from sim import Sim


class SceneDestinationGateTest(unittest.TestCase):
    def test_scene_without_destination_does_not_fire(self):
        root = tempfile.mkdtemp()
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=root, no_build=True,
                  build_mode="cache", fsm_params={"build": 45},
                  scene_world="koshakan")
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        t = [0.0]
        sim.clock.now = lambda: t[0]
        sim.fsm.new_scene(0.0, sim.fsm.objects)
        entry = dict(sim.scene_registry["koshakan_shop"])
        entry["destination"] = None
        sim.scene_registry["koshakan_shop"] = entry
        sim.cleaner = lambda raw: {"clean": raw, "intent": "scene", "confidence": 0.9}
        r = sim.post_idea({"kind": "idea", "id": "nodest", "source": "operator",
                           "value": "внутри магазина, начни строить сейчас"})
        self.assertTrue(r["ok"], r)
        sim._idea_step()
        self.assertEqual(sim.fsm.state, "idle")
        self.assertIsNone(sim._cache_build)
        self.assertNotIn(sim.ideas.get("nodest")["status"], ("firing", "done"))


if __name__ == "__main__":
    unittest.main()
