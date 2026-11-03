# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import fsm as fsm_mod
from test_fsm import fsm


def test_rearm_force_consult_restores_force_pending():
    f = fsm()
    f.tick(f.p["force"] + 1)  # idle past force: force_pending/force_active armed
    assert f.due(f.p["force"] + 1) == "force"
    ticket = f.begin_consult(f.p["force"] + 1)
    assert ticket["hint"] == "force"
    f.in_flight = False  # reply dropped (safety pause / transport error)
    f.rearm_consult(ticket)
    assert f.due(f.p["force"] + 2) == "force", (
        "expected due()=='force' after the force consult was dropped and re-armed, got %r"
        % (f.due(f.p["force"] + 2),))


from bughunt_fix import as_testcase  # noqa: E402

B40 = as_testcase(globals(), "B40")
