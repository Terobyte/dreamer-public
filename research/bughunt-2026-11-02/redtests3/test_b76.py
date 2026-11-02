"""B76: stand_on should choose the upper surface when sit is also allowed."""
from make.stage import _pick_surface


def test_stool_prefers_highest_standing_surface():
    lower = {"y": 0.2, "area": 0.2, "open": True}
    upper = {"y": 0.4, "area": 0.12, "open": True}
    chosen = _pick_surface([lower, upper], 0.0, ["stand_on", "sit"])
    assert chosen is upper, f"expected stand_on surface at y=0.4, got y={chosen['y']}"


def test_sit_only_still_chooses_largest_surface():
    lower = {"y": 0.2, "area": 0.2, "open": True}
    upper = {"y": 0.4, "area": 0.12, "open": True}
    assert _pick_surface([lower, upper], 0.0, ["sit"]) is lower
