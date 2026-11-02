import os
import random
import tempfile
from unittest import mock

from dialogue import Dialogue
from fake import FakeTransport
from sim import Sim, load_profile
from test_phase1_util import manual_clock


class Holder:
    def addCleanup(self, fn, *a):
        self.cleanups.append((fn, a))


def make_sim(case):
    """Same fixture as h0/dream/test_bugs_sim_queue.py (fake sim, manual clock)."""
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
