"""B84: a failed live director reply must requeue its consult input."""

import json

from director import Director
from fake import FakeTransport
from fsm import BuildFSM


class ManualClock:
    def now(self):
        return 11.0


class BrokenFakeTransport(FakeTransport):
    def complete(self, *args, **kwargs):
        raise RuntimeError("synthetic transport failure")


def _nudged_fsm():
    fsm = BuildFSM([], now=0.0)
    fsm.tick(fsm.p["nudge"])
    ticket = fsm.begin_consult(fsm.p["nudge"])
    assert ticket["hint"] == "nudge"
    return fsm, ticket


def test_transport_failure_requeues_events_and_rearms_nudge():
    fsm, ticket = _nudged_fsm()
    event = {"type": "input", "source": "speech", "value": "hello"}
    director = Director(fsm, fake=False, transport=BrokenFakeTransport(), clock=ManualClock())

    # Drive the same synchronous finish path as the worker, with no real wait.
    director._finish(ticket, "prompt", queued=[event])

    assert director.pending == [event], (
        "expected failed consult input to be requeued; actual pending=%r" % director.pending
    )
    assert fsm.nudge_pending is True, "expected dropped nudge consult to be re-armed"


def test_successful_noop_reply_is_not_requeued():
    fsm, ticket = _nudged_fsm()
    event = {"type": "input", "source": "speech", "value": "hello"}
    director = Director(fsm, fake=False,
                        transport=FakeTransport([json.dumps({"bridge": None, "messages": []})]),
                        clock=ManualClock())

    director._finish(ticket, "prompt", queued=[event])

    assert director.pending == []
    assert fsm.nudge_pending is False
