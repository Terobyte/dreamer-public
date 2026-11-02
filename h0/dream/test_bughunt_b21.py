# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
import inspect

import fsm as fsm_mod


def _make_fsm():
    candidates = []
    for name in ("FSM", "DreamFSM", "Fsm", "Machine"):
        if hasattr(fsm_mod, name):
            candidates.append(getattr(fsm_mod, name))
    # fallback: any class with finish_consult
    if not candidates:
        for v in vars(fsm_mod).values():
            if inspect.isclass(v) and hasattr(v, "finish_consult"):
                candidates.append(v)
    assert candidates, "no FSM class found"
    cls = candidates[0]
    # try common constructor shapes
    for kw in ({}, {"actors": []}, {"actors": None}, {"params": {}}, {"p": {}}):
        try:
            sig = inspect.signature(cls)
            filtered = {k: v for k, v in kw.items() if k in sig.parameters}
            obj = cls(*[], **filtered) if filtered else None
            if obj is None:
                try:
                    obj = cls()
                except Exception:
                    continue
            return obj
        except Exception:
            continue
    # last resort: __new__ without __init__
    obj = cls.__new__(cls)
    return obj


def _force_transition(f):
    # ensure minimal attrs exist
    if not hasattr(f, "p") or not isinstance(getattr(f, "p"), dict):
        f.p = {}
    for k in ("force", "build", "ready_timeout", "min_interval"):
        if k not in f.p:
            f.p[k] = 1000000
    f.state = "transition"
    if not hasattr(f, "build_epoch"):
        f.build_epoch = 0
    f.in_flight = True
    f.awake = False
    if not hasattr(f, "actors"):
        f.actors = []
    if not hasattr(f, "pending_wakeup"):
        f.pending_wakeup = None
    if not hasattr(f, "fail_streak"):
        f.fail_streak = 0
    if not hasattr(f, "nudge_delivered"):
        f.nudge_delivered = False
    ticket = {
        "epoch": f.build_epoch,
        "state": "transition",
        "label": "free",
        "hint": None,
        "nudged_before": False,
        "t_call": 0,
        "pending_wakeup": None,
    }
    return ticket


def test_abort_in_transition_is_invalid():
    f = _make_fsm()
    ticket = _force_transition(f)
    now = 12345
    decision = {"abort_build": {"reason": "stop"}}
    evs = f.finish_consult(now, ticket, decision)
    consults = [e for e in evs if e.get("type") == "consult"]
    assert consults, f"no consult event in {evs}"
    verdict = consults[-1].get("verdict")
    # expected: invalid abort rejected for transition phase
    assert verdict == "invalid", f"expected verdict 'invalid', got {verdict!r}; events={evs}"


class BughuntB21(unittest.TestCase):
    def test_b21(self):
        test_abort_in_transition_is_invalid()
