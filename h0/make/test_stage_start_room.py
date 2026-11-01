"""Book scene starts in its own room: on the one-place Koshakan home the meadow scene put Mama and Mirai
in the bathroom (the tightest group of the whole house). The scene's room = its `room` field, else its id."""
import json
import tempfile
import unittest
from pathlib import Path

from make import stage

PLACES = [{"name": "tub", "room": "bathroom", "at": [0.0, 0.0]}, {"name": "stool", "room": "bathroom", "at": [0.4, 0.0]},
          {"name": "m1", "room": "meadow", "at": [0.0, -8.0]}, {"name": "m2", "room": "meadow", "at": [2.5, -9.0]}]


class StartInRoom(unittest.TestCase):
    def test_room_limits_the_start(self):
        start = stage.pick_start(PLACES, ["Mirai", "Mama"], room="meadow")
        self.assertEqual(sorted(start.values()), ["m1", "m2"])

    def test_unknown_room_falls_back_to_the_whole_world(self):
        start = stage.pick_start(PLACES, ["Mirai", "Mama"], room="attic")
        self.assertEqual(sorted(start.values()), ["stool", "tub"])

    def test_scene_room_from_book(self):
        d = Path(tempfile.mkdtemp())
        (d / "book.json").write_text(json.dumps({"chapters": [{"scenes": [
            {"id": "meadow"}, {"id": "chapter2", "room": "bathroom"}]}]}))
        self.assertEqual(stage._scene_room(d, "meadow"), "meadow")
        self.assertEqual(stage._scene_room(d, "chapter2"), "bathroom")
        self.assertIsNone(stage._scene_room(d / "missing", "meadow"))


if __name__ == "__main__":
    unittest.main()
