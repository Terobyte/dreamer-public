"""Shared fixtures for the phase 1 offline tests (spec 7.2, "Фикстуры").
usage: from test_phase1_util import manual_clock, pump
Every phase 1 test drives the sim through pump(); no test here sleeps for real."""

from unittest import mock

from dialogue import TICK


def manual_clock(case, sim, start=0.0):
    """Patch sim.clock.now to read case.now (as test_sim.py does); pump() moves it."""
    case.now = start
    patch = mock.patch.object(sim.clock, "now", side_effect=lambda: case.now)
    patch.start()
    case.addCleanup(patch.stop)
    sim._manual = case
    return case


def pump(sim, ticks=1, consult=False):
    """One sim step per tick: clock += scale(TICK); _tick; _maybe_generate_line;
    optionally _maybe_consult (tests with a director); join the line worker."""
    for _ in range(ticks):
        sim._manual.now += sim.clock.scale(TICK)
        sim._tick()
        sim._maybe_generate_line()
        if consult:
            sim._maybe_consult(-1e9)
        th = sim._gen_thread
        if th is not None and th.is_alive():
            th.join(2)
