"""snap guards: missing level -> None (F3), outside-grid point not walkable (F4),
radius measured to cell centre (F5). usage: cd h0 && python3 -m unittest -q make.test_stage_snap"""
import base64
import unittest

from make.stage import _Nav


def _nav(cell, origin, w, h, walk):
    bits = bytearray((w * h + 7) // 8)
    n = walk[1] * w + walk[0]
    bits[n >> 3] |= 1 << (n & 7)
    return _Nav({"cell": cell, "layers": [
        {"level": "L0", "y": 0, "origin": list(origin), "w": w, "h": h,
         "bits": base64.b64encode(bytes(bits)).decode()}]})


class Snap(unittest.TestCase):
    def test_missing_level_is_none(self):
        self.assertIsNone(_nav(1.0, (0.0, 0.0), 3, 3, (1, 1)).snap("L9", 1.5, 1.5))

    def test_outside_grid_is_not_walkable(self):
        nav = _nav(1.0, (0.0, 0.0), 3, 3, (0, 0))
        # just outside the origin: must snap to the (0, 0) centre, never echo the
        # outside point back as walkable (the int-truncation bug did exactly that).
        self.assertEqual(nav.snap("L0", -0.05, 0.5), [0.5, 0.5])
        # far outside: nothing within 1 m.
        self.assertIsNone(nav.snap("L0", -5.0, -5.0))

    def test_radius_uses_centre_distance(self):
        # cell 0.04: nearest walkable centre is 1.0196 m away -> over the 1 m limit.
        nav = _nav(0.04, (0.0, 0.0), 64, 4, (25, 0))
        self.assertIsNone(nav.snap("L0", 0.0004, 0.02))


if __name__ == "__main__":
    unittest.main()
