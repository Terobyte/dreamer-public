# B49: _edge_center must return None (not raise) on a 3-coordinate shape vertex
import pipe2.floor as floor


def test_skeleton_defects_survives_3d_shape_vertices():
    skeleton = {
        "rooms": [{"id": "r1", "shape": [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]]}],
        "openings": [{"id": "o1", "on": {"room": "r1", "edge": 0, "t": 0.5}}],
    }
    plan = {"rooms": {"r1": {"refs": [], "max_points": 1, "cues": ""}}, "openings": {"o1": {"owner": "r1"}}}
    try:
        floor.skeleton_defects(skeleton, plan)
    except AttributeError as exc:
        raise AssertionError(f"expected a defect list (malformed edge -> None), got AttributeError: {exc}")
