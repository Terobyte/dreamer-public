"""Book cast starts together: start places are the closest group, not round-robin over the place list."""
import unittest

from make import stage


class StartTogether(unittest.TestCase):
    def test_two_actors_get_the_two_nearest_places(self):
        places = [{"name": "nw", "at": [-9.3, 11.8]}, {"name": "tuft", "at": [-3.6, -5.7]},
                  {"name": "c", "at": [0.0, 0.0]}, {"name": "e", "at": [1.5, 0.5]}]
        start = stage.pick_start(places, ["Mirai", "Mama"])
        self.assertEqual(sorted(start.values()), ["c", "e"])

    def test_more_actors_than_places_reuses(self):
        start = stage.pick_start([{"name": "bed", "at": [0, 0]}], ["Mirai", "Mama"])
        self.assertEqual(start, {"Mirai": "bed", "Mama": "bed"})

    def test_no_places(self):
        self.assertEqual(stage.pick_start([], ["Mirai"]), {})


if __name__ == "__main__":
    unittest.main()
