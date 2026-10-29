"""Tests for cosmetic/fixture ownership and the finding mappers. Offline, no engine.

The engine-backed half of the mappers (navigation bisection) lives in
`test_blame.py`; everything here is pure, so the engine stub refuses to run.
"""

import copy
import unittest

from pipe2.blame import blame_global, blame_room
from pipe2.engine import scene_for_room
from pipe2.merge import merge, split_owners


def room(rid, x0, x1):
    return {
        "id": rid,
        "level": "L0",
        "height": 3.0,
        "shape": [[x0, 0], [x1, 0], [x1, 4], [x0, 4]],
        "floor": "grey",
        "ceiling": "white",
        "walls": {"material": "white", "thickness": 0.12},
    }


def skeleton():
    return {
        "version": 0,
        "name": "v2",
        "levels": [{"id": "L0", "y": 0}],
        "rooms": [room("A", 0, 4), room("B", 4, 8)],
        "openings": [
            {"id": "ab", "kind": "door", "at": [4, 2], "width": 0.9,
             "height": 2.1, "sill": 0},
            {"id": "win", "kind": "window", "at": [2, 0], "width": 1.0,
             "height": 1.0, "sill": 1.0},
        ],
        "stairs": [],
        "spawn": {"room": "A", "at": [1, 1], "yaw": 0},
        "style": {"ambient": 1.0},
        "materials": {"white": {"color": "#eeeae0"}, "grey": {"color": "#888888"}},
        "assets": {},
        "props": [],
        "lights": [{"kind": "hemi", "pos": [0, 3, 0], "color": "#ffffff", "power": 0.8}],
        "routes": [],
    }


PLAN = {
    "rooms": {"A": {"max_points": 2}, "B": {"max_points": 2}},
    "openings": {"ab": {"owner": "A"}, "win": {"owner": "A"}},
}


def fixture(rid):
    return {"kind": "counter", "room": rid, "from": [1, 1], "to": [2, 1],
            "material": "white"}


def prop(pid, rid, at):
    return {"id": pid, "asset": "a_p", "cat": "table", "room": rid, "at": at,
            "size": {"w": 0.5, "d": 0.5, "h": 0.5}, "mount": "floor", "solid": True}


def codes(issues, owner=None):
    return [i["code"] for i in issues if owner is None or i["owner"] == owner]


class NoEngine:
    """Any engine call here is a bug: these findings name their own owner."""

    def check_full(self, scene, work):  # pragma: no cover - must not run
        raise AssertionError("blame_global must not call the engine")


class TestCosmetic(unittest.TestCase):
    def test_own_wall_and_own_door(self):
        partials = {"A": {
            "materials": {"A_wall": {"color": "#102030"}},
            "cosmetic": {
                "room": {"walls": {"material": "A_wall", "bands": [
                    {"to": 0.2, "material": "A_wall"}]}, "floor": "A_wall"},
                "openings": {"ab": {"leaf": {"decal": "A_door"},
                                    "outside": {"backdrop": "A_sky"}}},
            },
        }}
        before = copy.deepcopy(skeleton())
        sk = skeleton()
        scene, issues = merge(sk, partials, PLAN)
        self.assertEqual([], issues)
        self.assertEqual(before, sk)

        a = scene["rooms"][0]
        self.assertEqual("A_wall", a["walls"]["material"])
        self.assertEqual([{"to": 0.2, "material": "A_wall"}], a["walls"]["bands"])
        self.assertEqual(0.12, a["walls"]["thickness"])
        self.assertEqual("A_wall", a["floor"])
        self.assertEqual("white", scene["rooms"][1]["walls"]["material"])
        self.assertEqual({"decal": "A_door"}, scene["openings"][0]["leaf"])
        self.assertEqual({"backdrop": "A_sky"}, scene["openings"][0]["outside"])

    def test_edges_material_is_cosmetic(self):
        partials = {"A": {"cosmetic": {"room": {"edges": {"0": {"material": "A_wall"}}}}}}
        scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual([], issues)
        self.assertEqual({"0": {"material": "A_wall"}}, scene["rooms"][0]["edges"])

    def test_foreign_opening_is_refused(self):
        partials = {"B": {"cosmetic": {"openings": {"ab": {"leaf": {"decal": "B_door"}}}}}}
        scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual(["OWN_OPENING"], codes(issues, "B"))
        self.assertNotIn("leaf", scene["openings"][0])

    def test_unknown_opening_is_refused(self):
        partials = {"A": {"cosmetic": {"openings": {"ghost": {"leaf": {"decal": "d"}}}}}}
        _scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual(["OWN_OPENING"], codes(issues, "A"))

    def test_geometry_in_cosmetic_is_refused(self):
        partials = {"A": {"cosmetic": {
            "room": {"shape": [[0, 0], [1, 0], [1, 1]], "height": 9.0,
                     "walls": {"thickness": 0.9}},
            "openings": {"ab": {"at": [4, 3], "leaf": {"open": False}}},
        }}}
        scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual(["OWN_GEOMETRY"] * 5, codes(issues, "A"))
        a = scene["rooms"][0]
        self.assertEqual(skeleton()["rooms"][0]["shape"], a["shape"])
        self.assertEqual(3.0, a["height"])
        self.assertEqual(0.12, a["walls"]["thickness"])
        self.assertEqual([4, 2], scene["openings"][0]["at"])
        self.assertNotIn("leaf", scene["openings"][0])

    def test_unknown_cosmetic_section_is_refused(self):
        partials = {"A": {"cosmetic": {"stairs": [], "rooms": []}}}
        _scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual(["OWN_GEOMETRY", "OWN_GEOMETRY"], codes(issues, "A"))

    def test_malformed_nested_cosmetic_value_is_refused_not_raised(self):
        before = copy.deepcopy(skeleton())
        sk = skeleton()
        partials = {"A": {"cosmetic": {"room": {"walls": 3}}}}
        scene, issues = merge(sk, partials, PLAN)
        self.assertEqual(before, sk)
        self.assertEqual(["OWN_GEOMETRY"], codes(issues, "A"))
        self.assertEqual("white", scene["rooms"][0]["walls"]["material"])

    def test_falsy_malformed_cosmetic_room_is_refused_not_accepted(self):
        partials = {"A": {"cosmetic": {"room": []}}}
        scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual(["OWN_GEOMETRY"], codes(issues, "A"))
        self.assertEqual("white", scene["rooms"][0]["walls"]["material"])

    def test_falsy_malformed_cosmetic_is_refused_not_accepted(self):
        partials = {"A": {"cosmetic": []}}
        scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual(["OWN_GEOMETRY"], codes(issues, "A"))
        self.assertEqual("white", scene["rooms"][0]["walls"]["material"])

    def test_malformed_opening_field_value_is_refused_not_raised(self):
        partials = {"A": {"cosmetic": {"openings": {"ab": {"leaf": 5}}}}}
        scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual(["OWN_GEOMETRY"], codes(issues, "A"))
        self.assertNotIn("leaf", scene["openings"][0])


class TestFixtures(unittest.TestCase):
    def test_own_fixture_lands_foreign_is_refused(self):
        partials = {"A": {"fixtures": [fixture("A"), fixture("B")]}}
        scene, issues = merge(skeleton(), partials, PLAN)
        self.assertEqual(["OWN_ROOM"], codes(issues, "A"))
        self.assertEqual(["A"], [f["room"] for f in scene["fixtures"]])


class TestBlameRoom(unittest.TestCase):
    def setUp(self):
        self.partials = {"A": {"props": [prop("A_1", "A", [1, 1])]}}
        self.scene = scene_for_room(skeleton(), self.partials, PLAN, "A")

    def blame(self, **issue):
        return next(iter(blame_room(self.scene, [issue], "A")))

    def test_nav_finding_is_the_rooms(self):
        self.assertEqual("A", self.blame(code="NAV_ROOM_CUT", path="/rooms/0"))
        self.assertEqual("A", self.blame(code="PROP_HITS_WALL", path="/props/0"))

    def test_structural_findings_are_the_skeletons(self):
        self.assertEqual("skeleton", self.blame(code="ROOMS_OVERLAP", path="/rooms/1"))
        self.assertEqual("skeleton", self.blame(code="ID_DUPLICATE", path="/rooms/1", v="B"))
        self.assertEqual("skeleton", self.blame(code="OPENING_OFF_WALL", path="/openings/1/at"))
        self.assertEqual("skeleton", self.blame(code="X", path="/stairs/0"))
        self.assertEqual("skeleton", self.blame(code="X", path="/levels/0/y"))
        self.assertEqual("skeleton", self.blame(code="X"))

    def test_duplicate_of_a_room_id_is_the_rooms(self):
        self.assertEqual("A", self.blame(code="ID_DUPLICATE", path="/props/0", v="A_1"))

    def test_own_opening_cosmetics_are_the_rooms(self):
        self.assertEqual("A", self.blame(code="REF_UNKNOWN", path="/openings/0/leaf/decal"))
        self.assertEqual("A", self.blame(code="REF_UNKNOWN", path="/openings/1/outside/backdrop"))

    def test_keys_name_their_room(self):
        self.assertEqual("A", self.blame(code="REF_KIND", path="/materials/A_x/tile"))
        self.assertEqual("A", self.blame(code="REF_UNKNOWN", path="/assets/A_t"))
        self.assertEqual("skeleton", self.blame(code="REF_KIND", path="/materials/white/tile"))
        self.assertEqual("skeleton", self.blame(code="REF_KIND", path="/materials/Z_x/tile"))

    def test_groups_keep_order(self):
        first = {"code": "X", "path": "/props/0"}
        second = {"code": "Y", "path": "/props/0"}
        self.assertEqual([first, second], blame_room(self.scene, [first, second], "A")["A"])


class TestBlameGlobal(unittest.TestCase):
    """The half of `blame_global` that needs no engine: every owner is named."""

    def setUp(self):
        self.partials = {
            "A": {"props": [prop("A_1", "A", [1, 1])],
                  "materials": {"A_x": {"tile": "A_t", "repeat_m": 2.0}},
                  "assets": {"A_t": {"kind": "object", "prompt": "a thing"}},
                  "cosmetic": {"room": {"walls": {"material": "A_missing"}},
                               "openings": {"ab": {"leaf": {"decal": "A_door"}}}},
                  "fixtures": [fixture("A")]},
            "B": {"props": [prop("B_1", "B", [5, 1])],
                  "lights": [{"kind": "point", "pos": [5, 2, 1],
                              "color": "#ffffff", "power": 1.0}]},
        }

    def blame(self, **issue):
        owners = blame_global(NoEngine(), "/nowhere", skeleton(), self.partials,
                              PLAN, [issue])
        return next(iter(owners))

    def test_objects_name_their_room(self):
        self.assertEqual("A", self.blame(code="PROP_OUTSIDE", path="/props/0/at"))
        self.assertEqual("B", self.blame(code="PROP_OUTSIDE", path="/props/1"))
        self.assertEqual("B", self.blame(code="LIGHT_X", path="/lights/1"))
        self.assertEqual("A", self.blame(code="FIXTURE_X", path="/fixtures/0"))

    def test_room_cosmetics_name_their_room(self):
        self.assertEqual("A", self.blame(code="REF_UNKNOWN", path="/rooms/0/walls/material"))
        self.assertEqual("B", self.blame(code="REF_UNKNOWN", path="/rooms/1/floor"))
        self.assertEqual("skeleton", self.blame(code="ROOMS_OVERLAP", path="/rooms/0/shape"))

    def test_opening_cosmetics_go_to_the_owner_in_the_plan(self):
        self.assertEqual("A", self.blame(code="REF_UNKNOWN", path="/openings/0/leaf/decal"))
        self.assertEqual("skeleton", self.blame(code="OPENING_OFF_WALL", path="/openings/0/at"))

    def test_keys_name_their_room(self):
        self.assertEqual("A", self.blame(code="REF_KIND", path="/materials/A_x/tile"))
        self.assertEqual("A", self.blame(code="REF_UNKNOWN", path="/assets/A_t"))
        self.assertEqual("skeleton", self.blame(code="REF_KIND", path="/materials/white/tile"))

    def test_skeleton_keeps_the_rest(self):
        self.assertEqual("skeleton", self.blame(code="X", path="/spawn/at"))
        self.assertEqual("skeleton", self.blame(code="X", path="/stairs/0"))
        self.assertEqual("skeleton", self.blame(code="X"))

    def test_prop_hits_prop_goes_to_one_owner_by_path(self):
        issue = {"code": "PROP_HITS_PROP", "path": "/props/1", "other": "A_1"}
        owners = blame_global(NoEngine(), "/nowhere", skeleton(), self.partials,
                              PLAN, [issue])
        self.assertEqual({"B": [issue]}, owners)

    def test_split_owners_agrees_on_prop_hits_prop(self):
        scene, _ = merge(skeleton(), self.partials, PLAN)
        issue = {"code": "PROP_HITS_PROP", "path": "/props/1", "other": "A_1"}
        self.assertEqual({"B": [issue]}, split_owners(scene, [issue]))


class TestRedContract(unittest.TestCase):
    def test_f1_spawn_nav_is_the_rooms(self):
        scene = {"rooms": [{"id": "A"}]}
        issue = {"code": "NAV_SPAWN_BLOCKED", "path": "/spawn/at"}
        self.assertEqual({"A": [issue]}, blame_room(scene, [issue], "A"))

    def test_f2_camera_longest_room_prefix(self):
        scene = {"rooms": [{"id": "B"}, {"id": "B_room"}],
                 "cameras": [{"id": "B_room_view"}]}
        from pipe2.merge import owner_of
        self.assertEqual("B_room", owner_of(scene, {"path": "/cameras/0"}))

    def test_f3_boundary_light_goes_to_contributor(self):
        from pipe2.merge import merge, owner_of
        sk = skeleton()
        sk["rooms"] = [room("A", 0, 4), room("B", 4, 8)]
        partials = {"B": {"lights": [{"kind": "point", "pos": [4, 2, 2],
                                       "color": "#ffffff", "power": 1.0}]}}
        scene, issues = merge(sk, partials, PLAN)
        self.assertEqual([], issues)
        self.assertEqual("B", owner_of(scene, {"path": "/lights/1"}))


class TestRedRound(unittest.TestCase):
    """Round blockers F4-F7: blame/routes ownership, contributor tracking, registry leak."""

    def test_f4_route_path_is_the_rooms(self):
        scene = {"rooms": [{"id": "A"}]}
        issue = {"code": "ROUTE_BLOCKED", "path": "/routes/0/path/1"}
        self.assertEqual({"A": [issue]}, blame_room(scene, [issue], "A"))

    def test_f5_decal_without_room_fields_is_the_contributors(self):
        sk = skeleton()
        partials = {"A": {"decals": [{"asset": "d", "y": 1.0,
                                       "size": {"w": 0.4, "h": 0.4}}]}}
        scene, issues = merge(sk, partials, PLAN)
        self.assertEqual([], issues)
        issue = {"code": "REF_UNKNOWN", "path": "/decals/0/asset"}
        owners = blame_global(NoEngine(), "/nowhere", sk, partials, PLAN, [issue])
        self.assertEqual({"A": [issue]}, owners)

    def test_f6_camera_with_longer_room_prefix_is_the_contributors(self):
        from pipe2.merge import owner_of
        sk = skeleton()
        sk["rooms"] = [room("A", 0, 4), room("A_B", 4, 8)]
        plan = {"rooms": {"A": {"max_points": 2}, "A_B": {"max_points": 2}}}
        partials = {"A": {"cameras": [{"id": "A_B_view", "pos": [1, 1.6, 1],
                                       "look": [2, 1.2, 1], "fov": 70}]}}
        scene, issues = merge(sk, partials, plan)
        self.assertEqual([], issues)
        self.assertEqual("A", owner_of(scene, {"path": "/cameras/0"}))

    def test_f7_registry_does_not_grow_with_revisions(self):
        import gc
        from pipe2 import merge as mergemod
        sk = skeleton()
        for _ in range(50):
            scene, _ = merge(sk, {"A": {"lights": [
                {"kind": "point", "pos": [1, 2, 1],
                 "color": "#ffffff", "power": 1.0}]}}, PLAN)
            del scene
        gc.collect()
        self.assertEqual(0, len(mergemod._CONTRIBUTOR))


if __name__ == "__main__":
    unittest.main()
