"""B86: terminal awake state must reject the ready-door touch path."""

from types import SimpleNamespace

from fsm import BuildFSM
from sim import Sim


class ManualClock:
    def now(self):
        return 500.0


def _ready_fsm():
    fsm = BuildFSM(["door"], now=0.0)
    fsm.start_build(0.0, "door", "next room")
    fsm.tick(fsm.p["build"])
    assert fsm.state == "ready"
    return fsm


def _sim_stub(fsm):
    emitted = []
    transitions = []
    sim = SimpleNamespace(fsm=fsm, clock=ManualClock(), _emit=emitted.append,
                           _apply_transition=lambda: transitions.append("applied"))
    return sim, emitted, transitions


def test_awake_fsm_rejects_ready_bridge_touch_through_sim_caller():
    fsm = _ready_fsm()
    fsm.budget_wakeup(499.0)
    assert fsm.awake is True
    sim, emitted, transitions = _sim_stub(fsm)

    events = Sim._touch(sim, "door", "click")

    assert not any(e["type"] == "transition" for e in events), (
        "expected awake FSM to reject bridge touch; actual events=%r" % events
    )
    assert transitions == []
    assert fsm.state == "ready"


def test_sleeping_ready_fsm_still_accepts_bridge_touch():
    fsm = _ready_fsm()
    sim, emitted, transitions = _sim_stub(fsm)

    events = Sim._touch(sim, "door", "click")

    assert [e["type"] for e in events] == ["transition"]
    assert transitions == ["applied"]
    assert emitted == events
