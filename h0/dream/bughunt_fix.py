"""Fixtures of the bughunt repros moved into the dream gate (unittest under tools/ptest.py).

make_sim: the fake sim with a manual clock (as h0/dream/test_bugs_sim_queue.py).
as_testcase: wraps the hunters' pytest-style test_* functions into a TestCase, giving
them tmp_path and monkeypatch, so their assertions run unchanged."""
import inspect
import os
import random
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pytest

from dialogue import Dialogue
from fake import FakeTransport
from sim import Sim, load_profile
from test_phase1_util import manual_clock


def make_sim(case):
    case.enterContext(mock.patch("urllib.request.urlopen",
                                 side_effect=AssertionError("network forbidden")))
    root = tempfile.mkdtemp()
    dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=lambda *a: ""),
                   rng=random.Random(0))
    dlg.background = False
    sim = Sim(profile="A", fake=True, speed=1.0, outdir=root, dialogue=dlg)
    case.addCleanup(sim.close)
    case.enterContext(mock.patch.object(sim.director, "consult_async"))
    manual_clock(case, sim)
    return sim


def as_testcase(ns, name):
    def method(fn):
        def run(self):
            kw = {}
            params = inspect.signature(fn).parameters
            if "tmp_path" in params:
                d = tempfile.TemporaryDirectory()
                self.addCleanup(d.cleanup)
                kw["tmp_path"] = Path(d.name)
            if "monkeypatch" in params:
                mp = pytest.MonkeyPatch()
                self.addCleanup(mp.undo)
                kw["monkeypatch"] = mp
            fn(**kw)
        run.__name__ = fn.__name__
        return run
    body = {k: method(v) for k, v in ns.items() if k.startswith("test_") and callable(v)}
    return type(name, (unittest.TestCase,), body)
