"""Г3 red: build_places reads build.json.surfaces -> top / lie.at / tiers (levels-relative)."""
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import stage

CELL = 0.05
ORIGIN = [-0.8, -1.0]


def _surf(y, i0, j0, ni, nj, open_=True, cells=None):
    cs = cells if cells is not None else [[i, j] for i in range(i0, i0 + ni) for j in range(j0, j0 + nj)]
    x0 = ORIGIN[0] + min(c[0] for c in cs) * CELL
    z0 = ORIGIN[1] + min(c[1] for c in cs) * CELL
    x1 = ORIGIN[0] + (max(c[0] for c in cs) + 1) * CELL
    z1 = ORIGIN[1] + (max(c[1] for c in cs) + 1) * CELL
    return {"y": y, "rect": [x0, z0, x1, z1], "area": len(cs) * CELL * CELL, "open": open_,
            "origin": list(ORIGIN), "cells": cs, "poly": [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]}


def _world(pid, size, surfaces, level_y=0.0, glb_pos=(3.0, 0.0, 2.0)):
    d = Path(tempfile.mkdtemp())
    (d / "dist").mkdir()
    level = "L1" if level_y else "L0"
    scene = {"rooms": [{"id": "room", "level": level}],
             "levels": [{"id": level, "y": level_y}],
             "props": [{"id": pid, "size": size, "room": "room"}]}
    (d / "scene.json").write_text(json.dumps(scene))
    mesh = {"id": pid, "kind": "prop", "room": "room", "glb": "x.glb", "glbPos": list(glb_pos), "glbYaw": 0}
    (d / "dist" / "geometry.json").write_text(json.dumps({"meshes": [mesh]}))
    w = h = 400
    bits = base64.b64encode(b"\xff" * (w * h // 8)).decode()
    (d / "dist" / "nav.json").write_text(json.dumps(
        {"cell": 0.04, "layers": [{"level": level, "y": level_y, "origin": [0, 0], "w": w, "h": h, "bits": bits}]}))
    build = {"doors": []}
    if surfaces is not None:
        build["surfaces"] = {pid: surfaces}
    (d / "dist" / "build.json").write_text(json.dumps(build))
    return d


def _place(pid, size, surfaces, **kw):
    res = stage.build_places(_world(pid, size, surfaces, **kw))
    return res["places"][0], res["warnings"]


BED = {"w": 1.6, "d": 2.0, "h": 0.75}


class PlacesSurfaces(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def test_bed_mattress_and_posts(self):
        mattress = _surf(0.45, 0, 0, 32, 40)
        posts = _surf(0.75, 0, 0, 2, 2)
        p, w = _place("room_bed", BED, [posts, mattress])
        self.assertAlmostEqual(p["top"], 0.45, places=3)
        self.assertAlmostEqual(p["lie"]["at"][0], 3.0, delta=0.06)
        self.assertAlmostEqual(p["lie"]["at"][1], 2.0, delta=0.06)
        self.assertNotIn("tiers", p)
        self.assertFalse(any("PLACE_NO_SURFACES" in x for x in w))

    def test_lie_rule_beats_sit_rule(self):
        mattress = _surf(0.45, 0, 0, 32, 20)  # 1.6 m2
        shelf = _surf(0.9, 0, 30, 16, 5)  # 0.2 m2, higher
        p, _ = _place("room_bed", BED, [mattress, shelf])
        self.assertAlmostEqual(p["top"], 0.45, places=3)

    def test_chair_seat(self):
        seat = _surf(0.45, 0, 0, 10, 10)  # 0.25 m2
        back = _surf(0.9, 0, 12, 10, 5)  # 0.125 m2
        p, _ = _place("room_chair", {"w": 0.5, "d": 0.5, "h": 1.0}, [seat, back])
        self.assertAlmostEqual(p["top"], 0.45, places=3)

    def test_no_surfaces_falls_back(self):
        p, w = _place("room_bed", BED, None)
        self.assertEqual(p["top"], 0.75)
        self.assertIn("PLACE_NO_SURFACES room_bed", w)

    def test_shelf_tiers(self):
        tiers = [_surf(y, 0, 0, 10, 4) for y in (1.5, 0.1, 0.5, 1.0)]
        p, _ = _place("room_shelf", {"w": 0.5, "d": 0.2, "h": 1.6}, tiers)
        self.assertEqual([round(t["y"], 3) for t in p["tiers"]], [0.1, 0.5, 1.0, 1.5])
        self.assertEqual(len(p["tiers"][0]["rect"]), 4)

    def test_level_relative(self):
        p, _ = _place("room_bed", BED, [_surf(3.45, 0, 0, 32, 40)], level_y=3.0)
        self.assertAlmostEqual(p["top"], 0.45, places=3)

    def test_l_shaped_bed_lie_in_covered_cell(self):
        cells = [[i, j] for i in range(0, 32) for j in range(0, 40) if not (i >= 16 and j >= 20)]
        p, _ = _place("room_bed", BED, [_surf(0.45, 0, 0, 0, 0, cells=cells)])
        lx, lz = p["lie"]["at"]
        i = int((lx - 3.0 - ORIGIN[0]) // CELL)
        j = int((lz - 2.0 - ORIGIN[1]) // CELL)
        self.assertIn([i, j], cells)


if __name__ == "__main__":
    unittest.main()
