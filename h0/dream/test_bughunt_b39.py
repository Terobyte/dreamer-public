# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest

from dialogue import TICK
from bughunt_fix import make_sim


class B39(unittest.TestCase):
    def test_prepared_npc_and_pending_narration_do_not_deadlock(self):
        sim = make_sim(self)
        sim.prepared_npc = "Hi"
        sim._prepared_meta = {"who": sim.actors[0], "role": "actor"}
        sim._narrate.append({"cause": "transition", "context": "somewhere new"})
        for _ in range(40):
            self.now += sim.clock.scale(TICK)
            sim._tick()
            sim._maybe_generate_line()
            th = sim._gen_thread
            if th is not None and th.is_alive():
                th.join(2)
        progressed = (not sim._narrate) or sim.prepared_npc is None
        self.assertTrue(progressed,
                        "expected narration started or prepared NPC line played after 40 ticks; "
                        "actual: _narrate=%r prepared_npc=%r narrating=%r"
                        % (sim._narrate, sim.prepared_npc, sim._narrating))


if __name__ == "__main__":
    unittest.main()
