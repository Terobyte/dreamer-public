# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
import types
from sim import Sim


class FakeClock:
    def __init__(self):
        self.t = 0.0
    def now(self):
        return self.t
    def scale(self, x):
        return x
    def real_sleep(self, dt):
        self.t += 1.0


class FakeWorker:
    def wait(self, timeout=None):
        return None


def _make_sim_awake_no_dialogue():
    sim = Sim.__new__(Sim)
    sim.clock = FakeClock()
    sim.book = None
    sim.n_transitions = 0
    sim._max_transitions = None
    sim.stopped = False
    sim.dialogue = None
    sim.fsm = types.SimpleNamespace(awake=True)
    sim.logger = None
    sim.director = FakeWorker()
    sim.memory = FakeWorker()
    sim._gen_thread = None
    sim._voicing = None
    sim.stop_reason = None
    sim._tick = lambda: []
    sim._budget_ok = lambda: True
    sim._maybe_generate_line = lambda: None
    sim._maybe_consult = lambda lc: lc
    sim._drain_director = lambda: None
    sim._join_judge = lambda timeout=None: None
    sim.wait_images = lambda: None
    return sim


def test_awake_without_dialogue_stops_as_awake():
    sim = _make_sim_awake_no_dialogue()
    sim.run(max_transitions=2, max_seconds=5.0)
    assert sim.stop_reason == "awake"


class BughuntB20(unittest.TestCase):
    def test_b20(self):
        test_awake_without_dialogue_stops_as_awake()
