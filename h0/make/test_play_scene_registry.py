"""D4 F14/F15: --director-prompt's scene registry is checked against the run's dist and the next
scene is the destination room's things, not a lone room marker."""

import json
import tempfile
import unittest
from pathlib import Path

from make import play


def run_dir(doors, rooms, places):
    d = Path(tempfile.mkdtemp())
    (d / "world" / "run").mkdir(parents=True)
    (d / "stage").mkdir()
    (d / "world" / "run" / "scene.json").write_text(json.dumps(
        {"rooms": [{"id": r} for r in rooms], "doors": [{"id": x} for x in doors], "props": []}))
    (d / "stage" / "places.json").write_text(json.dumps({"places": places}))
    return d


class SceneRegistryFromDist(unittest.TestCase):
    def test_f14_a_door_or_room_the_dist_lacks_refuses(self):
        with self.assertRaisesRegex(ValueError, "door 'door'"):
            play.scene_registry(run_dir(["door1"], ["bedroom", "bathroom"], []), "koshakan")
        with self.assertRaisesRegex(ValueError, "room 'bathroom'"):
            play.scene_registry(run_dir(["door"], ["living", "kitchen"], []), "koshakan")
        with self.assertRaises(FileNotFoundError):
            play.scene_registry(Path(tempfile.mkdtemp()), "koshakan")

    def test_f15_next_scene_is_the_rooms_things_and_the_walk_loads_them(self):
        d = run_dir(["door"], ["bedroom", "bathroom"],
                    [{"name": "bed", "room": "bedroom"}, {"name": "bathtub", "room": "bathroom"},
                     {"name": "sink", "room": "bathroom"}])
        reg = play.scene_registry(d, "koshakan")
        self.assertEqual(reg["koshakan_shop"]["next_scene"]["objects"], ["bathroom", "bathtub", "sink"])
        play._dream()
        from sim import Sim
        s = Sim(fake=True, outdir=tempfile.mkdtemp(), no_build=True, build_mode="cache",
                fsm_params={"build": 1}, scene_world=reg)
        try:
            actors = list(s.scene.get("actors") or [])
            s.clock.now = lambda: 0
            s._start_scene_build({"id": "x", "scene_id": "koshakan_shop"})
            s.clock.now = lambda: 1
            for e in s.fsm.tick(1):
                s._emit(e)
            self.assertEqual(s.place, "bathroom")
            self.assertIn("bathtub", s.scene["objects"])
            self.assertIn("sink", s.scene["objects"])
            self.assertNotIn("bed", s.scene["objects"])
            self.assertEqual(s.scene["actors"], actors)
        finally:
            s.close()


if __name__ == "__main__":
    unittest.main()
