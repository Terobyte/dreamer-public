# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
import threading
import pytest
import sim as sim_mod


def _make_sim_with_none_event():
    Sim = sim_mod.Sim
    s = object.__new__(Sim)
    # minimal state for _dialogue_turn pickup path (lines 1640-1666)
    s.safety_paused = False
    s._gen_lock = threading.Lock()
    line = {"role": "actor", "who": "Bob", "text": "hi"}
    s.n_transitions = 0
    s._turn_epoch = 0
    s._gen_result = (line, 0, 0, "Bob")
    s._gen_taken = None
    s._gen_who = "Bob"
    s._gen_epoch = 0
    s._discard_reason = "human"
    # B19 trigger: live voice mode -> _start_line returns None -> npc_start -> [None]
    s.npc_start = lambda ln: [None]
    s._diagnostic = lambda *a, **k: None
    s._emit = lambda *a, **k: None
    s._return_taken = lambda *a, **k: None
    # state for the free-tick tail so it returns cleanly after pickup
    s._gen_thread = None
    s.prepared_npc = object()  # forces early return at line 1683
    s.next_line = None
    s._narrate = []
    s._narrating = False
    return s


def test_dialogue_turn_tolerates_none_voice_event():
    s = _make_sim_with_none_event()
    try:
        s._dialogue_turn()
    except TypeError as e:
        assert False, f"B19: _dialogue_turn crashed on [None] event: {e!r}"


class BughuntB19(unittest.TestCase):
    def test_b19(self):
        test_dialogue_turn_tolerates_none_voice_event()
