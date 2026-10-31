"""Red: world_run scene.json follows the engine contract (F9/F13).

Fixture must carry cats sofa/chair/table/lamp/rug, sizes as {w,d,h},
lamp mounted on the table, rug non-solid, rooms with height — while
keeping the legacy size_m/pos fields the old gate test relies on.
"""
import json
import unittest
from pathlib import Path

DATA = Path(__file__).resolve().parent / "testdata" / "world_run"


class SceneContract(unittest.TestCase):
    def test_scene_engine_contract(self):
        sc = json.loads((DATA / "scene.json").read_text())
        by_cat = {x.get("cat", x.get("id")): x for x in sc["props"]}
        self.assertTrue(
            {"sofa", "chair", "table", "lamp", "rug"} <= set(by_cat),
            f"need sofa/chair/table/lamp/rug cats, got {sorted(by_cat)}",
        )
        self.assertEqual(by_cat["lamp"].get("mount", {}).get("top_of"), "table")
        self.assertIs(by_cat["rug"].get("solid"), False)
        for pid, p in by_cat.items():
            self.assertTrue(
                {"w", "d", "h"} <= set(p.get("size", {})),
                f"prop {pid} needs size{{w,d,h}}",
            )
            # backward compat for the old gate test
            self.assertIn("size_m", p, f"prop {pid} keeps size_m")
        for r in sc["rooms"]:
            self.assertIn("height", r, f"room {r.get('id')} needs height")


if __name__ == "__main__":
    unittest.main()
