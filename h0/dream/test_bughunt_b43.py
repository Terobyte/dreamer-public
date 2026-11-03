# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest

from bughunt_fix import make_sim

NEXT = {"actors": [{"name": "Sandy", "voice": "woman"}],
        "objects": ["tree", "rock", "lab", "dome", "hammock"]}


class B43(unittest.TestCase):
    def test_transition_resets_actor_streak_for_human_hero(self):
        sim = make_sim(self)
        sim.hero_owner = "human"
        sim._actor_streak = 2  # two actor lines in a row in the old scene (ACTOR_STREAK_MAX)
        sim._spoke_last = sim.actors[0]
        sim.fsm.next_scene = NEXT
        sim.fsm.destination = "treedome"
        sim._apply_transition()
        self.assertEqual(sim._actor_streak, 0,
                         "expected _actor_streak reset to 0 on scene change (as _book_scene_end); "
                         "actual: %r (new actors blocked while hero is human)" % sim._actor_streak)


if __name__ == "__main__":
    unittest.main()
