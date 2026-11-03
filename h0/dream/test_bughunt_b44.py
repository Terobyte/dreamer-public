# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest

from bughunt_fix import make_sim

NEXT = {"actors": [{"name": "Sandy", "voice": "woman"}],
        "objects": ["tree", "rock", "lab", "dome", "hammock"]}


class B44(unittest.TestCase):
    def test_transition_drops_prepared_line_of_the_previous_scene(self):
        sim = make_sim(self)
        old_speaker = sim.actors[0]
        self.assertNotEqual(old_speaker, "Sandy")
        sim.prepared_npc = "Wait here!"
        sim._prepared_meta = {"who": old_speaker, "role": "actor"}
        sim.fsm.next_scene = NEXT
        sim.fsm.destination = "treedome"
        sim._apply_transition()
        self.assertEqual(sim.actors, ["Sandy"])
        stale = (sim.prepared_npc is not None
                 and (sim._prepared_meta or {}).get("who") not in sim.actors)
        self.assertFalse(stale,
                         "expected prepared_npc cleared on scene change; actual: prepared_npc=%r "
                         "who=%r, new cast=%r" % (sim.prepared_npc,
                                                  (sim._prepared_meta or {}).get("who"), sim.actors))


if __name__ == "__main__":
    unittest.main()
