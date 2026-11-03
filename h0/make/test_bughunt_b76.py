"""B76: stand_on should choose the upper surface when sit is also allowed."""
import unittest

from make.stage import _pick_surface


class PickSurface(unittest.TestCase):
    lower = {"y": 0.2, "area": 0.2, "open": True}
    upper = {"y": 0.4, "area": 0.12, "open": True}

    def test_stool_prefers_highest_standing_surface(self):
        self.assertIs(_pick_surface([self.lower, self.upper], 0.0, ["stand_on", "sit"]), self.upper)

    def test_sit_only_still_chooses_largest_surface(self):
        self.assertIs(_pick_surface([self.lower, self.upper], 0.0, ["sit"]), self.lower)


if __name__ == "__main__":
    unittest.main()
