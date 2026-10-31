"""make M4: sim.run(plan=, no_build=), fsm no_build, sim.seed_start.
usage: cd h0/dream && python3 -m unittest -q test_make_hooks
"""
import os
import tempfile
import unittest
from unittest import mock

import fsm
import sim as S
from fake import FakeTransport
from test_phase3_seed import _reply

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK = os.path.join(HERE, "books", "gwtw")


class Hooks(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))

    def tearDown(self):
        S.use_scene("start")

    def test_fsm_no_build_is_invalid_and_keeps_state(self):
        f = fsm.BuildFSM(["door"], no_build=True)
        ev = f.start_build(1.0, "a bridge", "elsewhere")
        self.assertEqual([e["type"] for e in ev], ["invalid"])
        self.assertEqual(ev[0]["reason"], "no_build")
        self.assertEqual(f.state, "idle")
        self.assertEqual(f.build_epoch, 0)
        g = fsm.BuildFSM(["door"])  # default: as before
        self.assertEqual(g.start_build(1.0, "b", "d")[0]["type"], "build")

    def test_run_takes_plan_without_loading_the_book(self):
        plan = S._load_book_plan(BOOK, ["library"])
        plan["scenes"][0]["dict"]["objects"] = ["armchair", "window"]
        seen = {}

        class Boom(Exception):
            pass

        def fake_sim(*a, **kw):
            seen.update(kw)
            raise Boom

        with mock.patch.object(S, "_load_book_plan", side_effect=AssertionError("must not load")), \
                mock.patch.object(S, "Sim", fake_sim), self.assertRaises(Boom):
            S.run(plan=plan, book=BOOK, scenes=["library"], profile=None, label="make_book",
                  no_build=True)
        self.assertIs(seen["book"], plan)
        self.assertTrue(seen["no_build"])
        self.assertEqual(S.START_SCENE["objects"], ["armchair", "window"])

    def test_seed_start_replaces_objects_with_the_places(self):
        scene, first = S.seed_start("two strangers stuck in a lift", FakeTransport([_reply()]),
                                    ["armchair", "window"])
        self.assertEqual(scene["objects"], ["armchair", "window"])
        self.assertEqual(scene["place"], "a cold lift")
        self.assertEqual([e["label"] for e in first], ["seed"])
        self.assertEqual(S.START_SCENE["objects"], ["armchair", "window"])

    def test_seed_start_none_when_director_fails(self):
        with self.assertRaises(ValueError):
            S.seed_start("x", FakeTransport(["nope", "nope"]), ["a"])


if __name__ == "__main__":
    unittest.main()
