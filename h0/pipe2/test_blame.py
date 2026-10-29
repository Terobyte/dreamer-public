"""Blame on the real engine: who cut navigation apart.

A synthetic four-room floor -- a corridor with rooms A and C off it, and B
only reachable through A -- checked by the real `dreamer check`/`--built`, so
the navigation findings are the engine's own, not a fixture's idea of them.
Nothing is written outside `tempfile.mkdtemp()`; `build` is `--assets none`.
"""

import os
import shutil
import tempfile
import unittest

from pipe2.blame import blame_global, blame_room
from pipe2.engine import Engine, blocking, green
from pipe2.merge import merge

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(REPO, "engine")


def room(rid, x0, x1, z0, z1):
    return {
        "id": rid,
        "level": "L0",
        "height": 3.0,
        "shape": [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
        "floor": "grey",
        "ceiling": "white",
        "walls": {"material": "white"},
    }


def door(oid, at):
    return {"id": oid, "kind": "arch", "at": at, "width": 1.0, "height": 2.1, "sill": 0}


def skeleton():
    """Corridor + A + C off it, and B behind A: cutting A cuts B off."""
    return {
        "version": 0,
        "name": "bench",
        "levels": [{"id": "L0", "y": 0}],
        "rooms": [
            room("corridor", 0, 12, 0, 2),
            room("A", 0, 4, 2, 8),
            room("B", 0, 4, 8, 14),
            room("C", 4, 8, 2, 8),
        ],
        "openings": [door("d_a", [2, 2]), door("d_b", [2, 8]), door("d_c", [6, 2])],
        "stairs": [],
        "spawn": {"room": "corridor", "at": [1, 1], "yaw": 0},
        "style": {"ambient": 1.0},
        "materials": {"white": {"color": "#eeeae0"}, "grey": {"color": "#888888"}},
        "assets": {"p_box": {"kind": "object", "prompt": "a plain grey box"}},
        "props": [],
        "decals": [],
        "cameras": [],
        "lights": [{"kind": "hemi", "pos": [0, 3, 0], "color": "#ffffff", "power": 0.8}],
        "routes": [{"id": "to_b", "path": ["spawn", "d_a", "d_b",
                                          {"room": "B", "at": [2, 11]}]}],
    }


PLAN = {
    "rooms": {r: {"max_points": 2} for r in ("corridor", "A", "B", "C")},
    "openings": {"d_a": {"owner": "A"}, "d_b": {"owner": "A"}, "d_c": {"owner": "C"}},
}


def box(pid, rid, at, w, d, h=0.9):
    return {"id": pid, "asset": "p_box", "cat": "sofa", "room": rid, "at": at,
            "size": {"w": w, "d": d, "h": h}, "mount": "floor", "yaw": 0,
            "solid": True}


#: a sofa across room A, wide enough to leave no way through to B
BARRICADE = ("A", [2, 5.0], 3.7, 0.9)


class Counting:
    """The engine, counting `check_full`: bisection must not run it per finding."""

    def __init__(self, engine):
        self.engine = engine
        self.full = 0

    def check_full(self, scene, work):
        self.full += 1
        return self.engine.check_full(scene, work)


class BlameOnEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = Engine(ENGINE, shots=False)

    def setUp(self):
        self.work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.work, True)

    def floor(self, skeleton_, partials):
        scene, violations = merge(skeleton_, partials, PLAN)
        self.assertEqual([], violations)
        return scene, self.engine.check_full(scene, self.work)

    def test_bench_is_green(self):
        partials = {"A": {"props": [box("A_1", "A", [1, 3], 0.8, 0.8)]},
                    "C": {"props": [box("C_1", "C", [6, 5], 0.8, 0.8)]}}
        _scene, report = self.floor(skeleton(), partials)
        self.assertTrue(green(report), report["raw"])

    def test_nav_cut_blames_culprit(self):
        partials = {
            "A": {"props": [box("A_1", *BARRICADE)]},
            "B": {"props": [box("B_1", "B", [2, 11], 0.8, 0.8)]},
            "C": {"props": [box("C_1", "C", [6, 5], 0.8, 0.8)]},
        }
        _scene, report = self.floor(skeleton(), partials)
        issues = blocking(report)
        cut = [i for i in issues if i.get("code") == "NAV_ROOM_CUT"]
        routed = [i for i in issues if i.get("code") == "ROUTE_BLOCKED"]
        self.assertTrue(cut, [i.get("code") for i in issues] or report["raw"])
        self.assertTrue(routed, [i.get("code") for i in issues] or report["raw"])

        counting = Counting(self.engine)
        owners = blame_global(counting, self.work, skeleton(), partials, PLAN, issues)
        for issue in cut + routed:
            self.assertIn(issue, owners.get("A", []),
                          "%s went to %s" % (issue.get("code"), owners.keys()))
        self.assertNotIn("B", owners)
        # one `check_full` per suspect room for the whole batch, not per finding
        self.assertLessEqual(counting.full, len(skeleton()["rooms"]))

    def test_unknown_material_in_cosmetic_blames_the_room(self):
        """The engine's own path for a dressed wall must reach its room."""
        partials = {"A": {"cosmetic": {"room": {"walls": {"material": "A_missing"}}}}}
        scene, violations = merge(skeleton(), partials, PLAN)
        self.assertEqual([], violations)
        issues = [i for i in blocking(self.engine.check(scene, self.work))
                  if i.get("code") == "REF_UNKNOWN"]
        self.assertTrue(issues, self.engine.check(scene, self.work)["raw"])

        self.assertEqual({"A": issues}, blame_room(scene, issues, "A"))
        counting = Counting(self.engine)
        self.assertEqual(
            {"A": issues},
            blame_global(counting, self.work, skeleton(), partials, PLAN, issues),
        )
        self.assertEqual(0, counting.full)

    def test_route_blocked_by_the_skeleton(self):
        """The barricade is the skeleton's: no room's removal clears the route."""
        sk = skeleton()
        sk["props"] = [box("barricade", *BARRICADE)]
        partials = {"A": {"props": [box("A_1", "A", [1, 3], 0.8, 0.8)]},
                    "C": {"props": [box("C_1", "C", [6, 5], 0.8, 0.8)]}}
        _scene, report = self.floor(sk, partials)
        issues = [i for i in blocking(report)
                  if i.get("code") in ("ROUTE_BLOCKED", "NAV_ROOM_CUT")]
        self.assertTrue(issues, report["raw"])

        owners = blame_global(self.engine, self.work, sk, partials, PLAN, issues)
        self.assertEqual({"skeleton": issues}, owners)


if __name__ == "__main__":
    unittest.main()
