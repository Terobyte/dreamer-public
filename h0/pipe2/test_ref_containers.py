"""Г5: a container prop is redrawn with everything on and in it; props mounted on it vanish."""
import json
import tempfile
import unittest
from pathlib import Path

from pipe2.floor import FloorResult, attach_refs

PROMPTS = Path(__file__).parent / "prompts"


def _scene(extra=None):
    props = [
        {"id": "bedroom_shelf", "asset": "a_shelf", "room": "bedroom"},
        {"id": "bedroom_bed", "asset": "a_bed", "room": "bedroom"},
    ]
    props += extra or []
    return {"assets": {"a_shelf": {"kind": "object", "prompt": "shelf"},
                       "a_bed": {"kind": "object", "prompt": "bed"},
                       "a_toy": {"kind": "object", "prompt": "toy"}},
            "props": props}


class RefContainers(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.frame = self.tmp / "bedroom.png"
        self.frame.write_bytes(b"\x89PNG\r\n\x1a\nbedroom")
        self.out = self.tmp / "run"
        self.out.mkdir()
        self.plan = {"rooms": {"bedroom": {"refs": [str(self.frame)]}}}

    def run_attach(self, scene, plan=None):
        warnings = []
        attach_refs(scene, self.plan if plan is None else plan, self.out, warnings)
        return warnings

    def test_container_redraw_and_short_names(self):
        scene = _scene()
        self.run_attach(scene)
        shelf = scene["assets"]["a_shelf"]["ref"]
        self.assertEqual(shelf["mode"], "redraw")
        self.assertEqual(shelf["what"], "shelf with everything standing on it and inside it")
        bed = scene["assets"]["a_bed"]["ref"]
        self.assertEqual(bed["what"], "bed")
        self.assertNotIn("mode", bed)

    def test_top_of_removed_with_warning(self):
        scene = _scene([{"id": "bedroom_toyhouse", "asset": "a_toy", "room": "bedroom",
                         "mount": {"top_of": "bedroom_shelf"}}])
        warnings = self.run_attach(scene)
        self.assertNotIn("bedroom_toyhouse", [p["id"] for p in scene["props"]])
        self.assertEqual(warnings, ["CONTAINED bedroom_toyhouse in bedroom_shelf"])

    def test_tier_of_removed(self):
        scene = _scene([{"id": "bedroom_toyhouse", "asset": "a_toy", "room": "bedroom",
                         "mount": {"tier_of": "bedroom_shelf", "tier": 1}}])
        self.run_attach(scene)
        self.assertNotIn("bedroom_toyhouse", [p["id"] for p in scene["props"]])

    def test_without_image_stays(self):
        scene = _scene([{"id": "bedroom_toyhouse", "asset": "a_toy", "room": "bedroom",
                         "mount": {"top_of": "bedroom_shelf"}}])
        warnings = self.run_attach(scene, {"rooms": {"bedroom": {}}})
        self.assertIn("bedroom_toyhouse", [p["id"] for p in scene["props"]])
        self.assertEqual(warnings, [])

    def test_prop_on_non_container_stays(self):
        scene = _scene([{"id": "bedroom_toyhouse", "asset": "a_toy", "room": "bedroom",
                         "mount": {"top_of": "bedroom_bed"}}])
        warnings = self.run_attach(scene)
        self.assertIn("bedroom_toyhouse", [p["id"] for p in scene["props"]])
        self.assertEqual(warnings, [])

    def test_shared_asset_first_prop_wins(self):
        scene = _scene([{"id": "bedroom_box", "asset": "a_shelf", "room": "bedroom"}])
        self.run_attach(scene)
        self.assertEqual(scene["assets"]["a_shelf"]["ref"]["mode"], "redraw")
        ids = [p["id"] for p in scene["props"]]
        self.assertIn("bedroom_box", ids)
        self.assertIn("bedroom_shelf", ids)

    def test_shared_asset_two_rooms_different_frames(self):
        other = self.tmp / "hall.png"
        other.write_bytes(b"\x89PNG\r\n\x1a\nhall")
        scene = _scene([{"id": "hall_shelf", "asset": "a_shelf", "room": "hall"}])
        plan = {"rooms": {"bedroom": {"refs": [str(self.frame)]}, "hall": {"refs": [str(other)]}}}
        self.run_attach(scene, plan)
        by_id = {p["id"]: p for p in scene["props"]}
        self.assertEqual(by_id["bedroom_shelf"]["asset"], "a_shelf")
        self.assertEqual(by_id["hall_shelf"]["asset"], "a_shelf__hall")
        self.assertNotEqual(scene["assets"]["a_shelf"]["ref"]["image"],
                            scene["assets"]["a_shelf__hall"]["ref"]["image"])
        self.assertEqual(scene["assets"]["a_shelf__hall"]["prompt"], "shelf")

    def test_floor_result_warnings_in_report(self):
        self.assertEqual(FloorResult(status="done").warnings, [])
        from dataclasses import asdict
        self.assertEqual(asdict(FloorResult(status="done", warnings=["w"]))["warnings"], ["w"])

    def test_floor_run_writes_warnings_to_report(self):
        import inspect
        import json as _json
        import tempfile as _tmp
        from pipe2 import floor as floor_mod
        from pipe2.floor import Floor
        # F1: source still wires warnings through run -> _write_report
        src = inspect.getsource(floor_mod)
        self.assertIn("warnings=warnings", src)
        self.assertIn("attach_refs(scene, plan, self.run_dir, warnings)", src)
        # F1: real report.json contains the same warnings list (not just source fragments)
        tmp = Path(_tmp.mkdtemp())
        run_dir = tmp / "run"
        run_dir.mkdir(parents=True)
        task_dir = tmp / "task"
        task_dir.mkdir(parents=True)

        class _DummySpark:
            ledger = None

        class _DummyAssets:
            def close(self):
                pass
        fl = Floor(task_dir=task_dir, run_dir=run_dir,
                   deps={"spark": _DummySpark(), "assets": _DummyAssets(), "engine": object()})
        warnings = ["CONTAINED bedroom_toyhouse in bedroom_shelf", "other"]
        fl._write_report(FloorResult(status="done", warnings=warnings))
        data = _json.loads((run_dir / "report.json").read_text())
        self.assertEqual(data["warnings"], warnings)

    def test_builder_rule(self):
        text = (PROMPTS / "builder.md").read_text()
        self.assertIn("то, что стоит на мебели или внутри неё, не выноси отдельным предметом", text)


if __name__ == "__main__":
    unittest.main()
