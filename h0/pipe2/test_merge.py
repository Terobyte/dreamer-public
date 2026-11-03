"""Tests for the pure merge/ownership/geometry layer. Offline, no engine."""

import copy
import json
import os
import unittest

from pipe2.geom import in_room
from pipe2.merge import merge, owner_of

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEMO = os.path.join(REPO, "specs", "examples", "demo.scene.json")

# in demo.scene.json every prop/decal/camera belongs to "living"
LIVING_ASSETS = ["p_table", "p_chair", "p_sofa", "p_vase", "p_lamp", "d_portrait"]


def prefixed_demo():
    """demo.scene.json with every room-owned id/key prefixed by its room."""
    with open(DEMO, encoding="utf-8") as fh:
        scene = json.load(fh)
    props = {p["id"]: "living_" + p["id"] for p in scene["props"]}
    assets = {k: "living_" + k for k in LIVING_ASSETS}
    for prop in scene["props"]:
        prop["id"] = props[prop["id"]]
        prop["asset"] = assets[prop["asset"]]
        mount = prop.get("mount")
        if isinstance(mount, dict) and "top_of" in mount:
            mount["top_of"] = props[mount["top_of"]]
        if "around" in prop:
            prop["around"]["center"] = props[prop["around"]["center"]]
    for decal in scene["decals"]:
        decal["asset"] = assets[decal["asset"]]
    for cam in scene["cameras"]:
        cam["id"] = "living_" + cam["id"]
    scene["assets"] = {assets.get(k, k): v for k, v in scene["assets"].items()}
    return scene


def cut_demo(scene):
    """Split a prefixed demo scene back into skeleton + per-room partials."""
    skeleton = copy.deepcopy(scene)
    props = skeleton.pop("props")
    decals = skeleton.pop("decals")
    cameras = skeleton.pop("cameras")
    lights = skeleton.pop("lights")
    skeleton["lights"] = [l for l in lights if l["kind"] == "hemi"]
    room_assets = {
        k: skeleton["assets"].pop(k)
        for k in list(skeleton["assets"])
        if k.startswith("living_")
    }
    points = [l for l in lights if l["kind"] != "hemi"]
    partials = {
        "living": {
            "props": props,
            "decals": decals,
            "cameras": cameras,
            "lights": [points[0]],
            "assets": room_assets,
        },
        "hall": {"lights": [points[1]]},
        "loft": {},
    }
    return skeleton, partials


DEMO_PLAN = {
    "rooms": {
        "living": {"max_points": 4},
        "hall": {"max_points": 4},
        "loft": {"max_points": 4},
    }
}


def mini_room(rid, x0):
    return {
        "id": rid,
        "level": "L0",
        "height": 3.0,
        "shape": [[x0, 0], [x0 + 4, 0], [x0 + 4, 4], [x0, 4]],
        "floor": "m",
        "ceiling": "m",
        "walls": {"material": "m"},
    }


def mini_skeleton():
    return {
        "version": 0,
        "name": "mini",
        "levels": [{"id": "L0", "y": 0}],
        "rooms": [mini_room("a", 0), mini_room("b", 4)],
        "openings": [],
        "stairs": [],
        "spawn": {"room": "a", "at": [1, 1], "yaw": 0},
        "style": {"ambient": 1.0},
        "materials": {"m": {"color": "#ffffff"}},
        "assets": {},
        "lights": [{"kind": "hemi", "pos": [0, 3, 0], "color": "#ffffff", "power": 0.8}],
        "routes": [],
    }


MINI_PLAN = {"rooms": {"a": {"max_points": 2}, "b": {"max_points": 2}}}


def prop(pid, room, at):
    return {
        "id": pid,
        "asset": "a_p",
        "cat": "table",
        "room": room,
        "at": at,
        "size": {"w": 0.5, "d": 0.5, "h": 0.5},
        "mount": "floor",
        "solid": True,
    }


def point(pos):
    return {"kind": "point", "pos": pos, "color": "#ffffff", "power": 1.0}


def codes(issues, owner=None):
    return [i["code"] for i in issues if owner is None or i["owner"] == owner]


class TestMergeRoundTrip(unittest.TestCase):
    def test_demo_round_trip(self):
        expected = prefixed_demo()
        skeleton, partials = cut_demo(expected)
        scene, issues = merge(skeleton, partials, DEMO_PLAN)
        self.assertEqual(issues, [])
        self.assertEqual(scene, expected)

    def test_room_order_is_skeleton_order(self):
        skeleton = mini_skeleton()
        partials = {
            "b": {"props": [prop("b_1", "b", [5, 1])]},
            "a": {"props": [prop("a_1", "a", [1, 1]), prop("a_2", "a", [2, 1])]},
        }
        scene, issues = merge(skeleton, partials, MINI_PLAN)
        self.assertEqual(issues, [])
        self.assertEqual([p["id"] for p in scene["props"]], ["a_1", "a_2", "b_1"])

    def test_skeleton_is_not_mutated(self):
        skeleton = mini_skeleton()
        before = copy.deepcopy(skeleton)
        merge(skeleton, {"a": {"props": [prop("a_1", "a", [1, 1])]}}, MINI_PLAN)
        self.assertEqual(skeleton, before)


class TestViolations(unittest.TestCase):
    def test_own_room_prop(self):
        scene, issues = merge(
            mini_skeleton(),
            {"a": {"props": [prop("a_1", "b", [5, 1]), prop("a_2", "a", [1, 1])]}},
            MINI_PLAN,
        )
        self.assertEqual(codes(issues), ["OWN_ROOM"])
        self.assertEqual(issues[0]["owner"], "a")
        self.assertEqual([p["id"] for p in scene["props"]], ["a_2"])

    def test_own_room_decal(self):
        good = {"asset": "a_d", "room": "a", "on": {"room": "a", "edge": 0, "t": 0.5},
                "y": 1.7, "size": {"w": 0.4, "h": 0.4}}
        bad = {"asset": "a_d", "room": "a", "on": {"room": "b", "edge": 0, "t": 0.5},
               "y": 1.7, "size": {"w": 0.4, "h": 0.4}}
        scene, issues = merge(mini_skeleton(), {"a": {"decals": [bad, good]}}, MINI_PLAN)
        self.assertEqual(codes(issues), ["OWN_ROOM"])
        self.assertEqual(scene["decals"], [good])

    def test_own_light_outside(self):
        inside = point([1, 2, 1])
        scene, issues = merge(
            mini_skeleton(), {"a": {"lights": [point([6, 2, 1]), inside]}}, MINI_PLAN
        )
        self.assertEqual(codes(issues), ["OWN_LIGHT_OUTSIDE"])
        self.assertEqual(scene["lights"], [mini_skeleton()["lights"][0], inside])

    def test_bulged_room_keeps_light_in_cap(self):
        skeleton = mini_skeleton()
        skeleton["rooms"][0]["shape"] = [[0, 0, {"bulge": 0.5}], [4, 0], [4, 4], [0, 4]]
        scene, issues = merge(
            skeleton, {"a": {"lights": [point([2, 2, -0.5])]}}, MINI_PLAN
        )
        self.assertEqual(issues, [])
        self.assertEqual(scene["lights"], [mini_skeleton()["lights"][0], point([2, 2, -0.5])])

    def test_own_light_budget_drops_tail(self):
        first, second, third = point([1, 2, 1]), point([2, 2, 1]), point([3, 2, 1])
        scene, issues = merge(
            mini_skeleton(), {"a": {"lights": [first, second, third]}}, MINI_PLAN
        )
        self.assertEqual(codes(issues), ["OWN_LIGHT_BUDGET"])
        self.assertEqual(scene["lights"][1:], [first, second])

    def test_own_hemi(self):
        hemi = {"kind": "hemi", "pos": [1, 3, 1], "color": "#ffffff", "power": 0.5}
        scene, issues = merge(mini_skeleton(), {"a": {"lights": [hemi]}}, MINI_PLAN)
        self.assertEqual(codes(issues), ["OWN_HEMI"])
        self.assertEqual(len(scene["lights"]), 1)

    def test_own_prefix_prop_and_camera(self):
        cam_bad = {"id": "view", "pos": [1, 1.6, 1], "look": [2, 1.2, 1], "fov": 70}
        cam_ok = {"id": "a_view", "pos": [1, 1.6, 1], "look": [2, 1.2, 1], "fov": 70}
        scene, issues = merge(
            mini_skeleton(),
            {"a": {"props": [prop("nope", "a", [1, 1]), prop("a_ok", "a", [2, 1])],
                   "cameras": [cam_bad, cam_ok]}},
            MINI_PLAN,
        )
        self.assertEqual(codes(issues), ["OWN_PREFIX", "OWN_PREFIX"])
        self.assertEqual([p["id"] for p in scene["props"]], ["a_ok"])
        self.assertEqual(scene["cameras"], [cam_ok])

    def test_own_prefix_assets_and_materials(self):
        scene, issues = merge(
            mini_skeleton(),
            {"a": {"assets": {"loose": {"kind": "object", "prompt": "x"},
                              "a_fine": {"kind": "object", "prompt": "y"}},
                   "materials": {"loose": {"color": "#000000"},
                                 "a_fine": {"color": "#111111"}}}},
            MINI_PLAN,
        )
        self.assertEqual(codes(issues), ["OWN_PREFIX", "OWN_PREFIX"])
        self.assertEqual(list(scene["assets"]), ["a_fine"])
        self.assertEqual(sorted(scene["materials"]), ["a_fine", "m"])

    def test_own_key(self):
        scene, issues = merge(
            mini_skeleton(),
            {"a": {"rooms": [mini_room("c", 20)], "props": [prop("a_1", "a", [1, 1])]}},
            MINI_PLAN,
        )
        self.assertEqual(codes(issues), ["OWN_KEY"])
        self.assertEqual([r["id"] for r in scene["rooms"]], ["a", "b"])
        self.assertEqual(len(scene["props"]), 1)

    def test_asset_key_conflict(self):
        scene, issues = merge(
            mini_skeleton(),
            {"a": {"assets": {"shared_x": {"kind": "object", "prompt": "red chair"}}},
             "b": {"assets": {"shared_x": {"kind": "object", "prompt": "blue chair"}}}},
            MINI_PLAN,
        )
        self.assertEqual(codes(issues), ["OWN_ASSET_CONFLICT", "OWN_ASSET_CONFLICT"])
        self.assertEqual({i["owner"] for i in issues}, {"a", "b"})
        self.assertNotIn("shared_x", scene["assets"])

    def test_asset_same_prompt_is_deduped(self):
        same = {"kind": "object", "prompt": "red chair"}
        scene, issues = merge(
            mini_skeleton(),
            {"a": {"assets": {"shared_x": dict(same)}},
             "b": {"assets": {"shared_x": dict(same)}}},
            MINI_PLAN,
        )
        self.assertEqual(issues, [])
        self.assertEqual(scene["assets"], {"shared_x": same})


class TestOwnerOf(unittest.TestCase):
    def setUp(self):
        skeleton = mini_skeleton()
        partials = {
            "a": {
                "props": [prop("a_1", "a", [1, 1])],
                "decals": [{"asset": "a_d", "room": "a",
                            "on": {"room": "a", "edge": 0, "t": 0.5},
                            "y": 1.7, "size": {"w": 0.4, "h": 0.4}}],
                "lights": [point([1, 2, 1])],
                "cameras": [{"id": "a_view", "pos": [1, 1.6, 1],
                             "look": [2, 1.2, 1], "fov": 70}],
            },
            "b": {"props": [prop("b_1", "b", [5, 1])]},
        }
        self.scene, issues = merge(skeleton, partials, MINI_PLAN)
        self.assertEqual(issues, [])

    def own(self, **issue):
        return owner_of(self.scene, issue)

    def test_prop_path(self):
        self.assertEqual(self.own(code="PROP_HITS_WALL", path="/props/0/at"), "a")
        self.assertEqual(self.own(code="PROP_HITS_WALL", path="/props/1"), "b")

    def test_decal_path(self):
        self.assertEqual(self.own(code="DECAL_OFF_WALL", path="/decals/0/on"), "a")

    def test_decal_path_uses_on_room(self):
        del self.scene["decals"][0]["room"]
        self.assertEqual(self.own(code="DECAL_OFF_WALL", path="/decals/0"), "a")

    def test_light_path_by_position(self):
        self.assertEqual(self.own(code="X", path="/lights/1/pos"), "a")
        self.assertEqual(self.own(code="X", path="/lights/0"), "skeleton")

    def test_camera_path_by_id_prefix(self):
        self.assertEqual(self.own(code="CAMERA_OUTSIDE", path="/cameras/0/pos"), "a")

    def test_room_path(self):
        self.assertEqual(self.own(code="ROOM_SELF_INTERSECT", path="/rooms/1"), "b")

    def test_skeleton_paths(self):
        for path in ("/openings/0/at", "/stairs/0", "/levels/0/y", "/spawn/at",
                     "/routes/0", "/style", ""):
            self.assertEqual(self.own(code="X", path=path), "skeleton", path)

    def test_findings_without_path(self):
        self.assertEqual(self.own(code="ID_DUPLICATE", v="a_1"), "skeleton")
        self.assertEqual(self.own(code="ROOMS_OVERLAP", a="a", b="b"), "skeleton")

    def test_unknown_index_is_skeleton(self):
        self.assertEqual(self.own(code="X", path="/props/99"), "skeleton")


class TestInRoom(unittest.TestCase):
    def setUp(self):
        self.square = mini_room("a", 0)
        self.circle = {"id": "c", "circle": {"c": [10, 10], "r": 2.0}}

    def test_polygon_inside_and_outside(self):
        self.assertTrue(in_room(self.square, 2.0, 2.0))
        self.assertFalse(in_room(self.square, 5.0, 2.0))
        self.assertFalse(in_room(self.square, 2.0, -0.5))

    def test_polygon_edge_and_vertex_are_inside(self):
        self.assertTrue(in_room(self.square, 0.0, 2.0))
        self.assertTrue(in_room(self.square, 2.0, 4.0))
        self.assertTrue(in_room(self.square, 0.0, 0.0))
        self.assertTrue(in_room(self.square, 4.0, 4.0))

    def test_polygon_ignores_bulge_annotation(self):
        room = {"id": "a", "shape": [[0, 0], [4, 0, {"bulge": 0.4}], [4, 4], [0, 4]]}
        self.assertTrue(in_room(room, 2.0, 2.0))

    def test_polygon_outward_bulge_counts_as_inside(self):
        room = {"id": "a", "shape": [[0, 0, {"bulge": 0.5}], [4, 0], [4, 4], [0, 4]]}
        self.assertTrue(in_room(room, 2.0, -0.5))
        self.assertFalse(in_room(room, 2.0, -1.5))

    def test_circle(self):
        self.assertTrue(in_room(self.circle, 10.0, 10.0))
        self.assertTrue(in_room(self.circle, 12.0, 10.0))
        self.assertFalse(in_room(self.circle, 12.5, 10.0))


if __name__ == "__main__":
    unittest.main()
