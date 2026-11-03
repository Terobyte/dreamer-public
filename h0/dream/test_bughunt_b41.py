# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
from fsm import BuildFSM
from test_fsm import OBJECTS, POOL, good


def test_no_build_start_is_not_reported_as_build_verdict():
    f = BuildFSM(OBJECTS, voices=POOL, now=0.0, no_build=True)
    ticket = f.begin_consult(1.0)
    ev = f.finish_consult(1.0, ticket, good())
    verdict = [e["verdict"] for e in ev if e["type"] == "consult"][-1]
    assert f.state == "idle"
    assert verdict == "invalid", "expected consult verdict 'invalid' (build was rejected, fsm idle), got %r" % verdict


from bughunt_fix import as_testcase  # noqa: E402

B41 = as_testcase(globals(), "B41")
