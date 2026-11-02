"""Plain colour surfaces in a room with a picture are findings."""
import unittest
from pathlib import Path

from pipe2.surface_rule import plain_surfaces

PROMPTS = Path(__file__).parent / "prompts"


def scene(room, **mats):
    return {"rooms": [dict({"id": "r"}, **room)], "materials": mats}


C = {"color": "#fff"}
T = {"tile": "t.png"}


class PlainSurfaces(unittest.TestCase):
    def test_floor(self):
        f = plain_surfaces(scene({"floor": "m_floor"}, m_floor=C), "r", True)
        self.assertEqual([(x["code"], x["path"], x["field"], x["owner"]) for x in f],
                         [("PLAIN_SURFACE", "/materials/m_floor", "floor", "r")])
        self.assertIn("r floor uses m_floor without a tile", f[0]["msg"])
        self.assertEqual(plain_surfaces(scene({"floor": "m_floor"}, m_floor=T), "r", True), [])

    def test_walls_band_edge(self):
        for room, field in (({"walls": {"material": "m"}}, "walls.material"),
                            ({"walls": {"bands": [{"to": 1, "material": "m"}]}},
                             "walls.bands[0].material"),
                            ({"edges": {"2": {"material": "m"}}}, 'edges["2"].material')):
            f = plain_surfaces(scene(room, m=C), "r", True)
            self.assertEqual([x["field"] for x in f], [field])
            self.assertEqual(plain_surfaces(scene(room, m=T), "r", True), [])

    def test_open_room_floor_only(self):
        s = scene({"open": True, "floor": "f"}, f=T)
        self.assertEqual(plain_surfaces(s, "r", True), [])

    def test_no_ref(self):
        self.assertEqual(plain_surfaces(scene({"floor": "m"}, m=C), "r", False), [])

    def test_missing_ids(self):
        s = scene({"floor": "nf", "walls": {"material": "nw"}})
        f = plain_surfaces(s, "r", True)
        self.assertEqual([x["path"] for x in f], ["/materials/nf", "/materials/nw"])

    def test_empty_string_id_is_violation(self):
        s = scene({"floor": "", "walls": {"material": ""}})
        f = plain_surfaces(s, "r", True)
        self.assertEqual(sorted([x["path"] for x in f]), ["/materials/", "/materials/"])
        self.assertEqual(sorted([x["field"] for x in f]), ["floor", "walls.material"])

    def test_empty_tile_string_not_violation(self):
        s = scene({"floor": "m_floor"}, m_floor={"tile": ""})
        self.assertEqual(plain_surfaces(s, "r", True), [])


class InventoryBlock(unittest.TestCase):
    def _msgs(self, refs):
        from pipe2.room import RoomPipeline
        p = RoomPipeline.__new__(RoomPipeline)
        p.room = "r"
        p.partial = {}
        p.ctx = type("C", (), {"plan": {"rooms": {"r": {"refs": refs}}}, "skeleton": {}})()
        p._shots = lambda: []
        p._refs = lambda row: []
        return p._critic_messages("critic_layout", {})[0]["content"][0]["text"]

    def test_inventory_only_with_ref(self):
        self.assertIn("перечисли каждый видимый на картинке предмет", self._msgs(["x.png"]))
        self.assertNotIn("перечисли каждый видимый на картинке предмет", self._msgs([]))
