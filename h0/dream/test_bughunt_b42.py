# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
from test_fsm import fsm


def test_idle_abort_build_is_not_ok_verdict():
    f = fsm()
    ticket = f.begin_consult(1.0)
    assert ticket["label"] != "forced"
    ev = f.finish_consult(1.0, ticket, {"abort_build": {"reason": "stop"}})
    assert any(e["type"] == "invalid" and e.get("reason") == "no_build" for e in ev)
    verdict = [e["verdict"] for e in ev if e["type"] == "consult"][-1]
    assert verdict == "invalid", "expected consult verdict 'invalid' for rejected abort in idle, got %r" % verdict


from bughunt_fix import as_testcase  # noqa: E402

B42 = as_testcase(globals(), "B42")
