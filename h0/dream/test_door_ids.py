"""A door event from the sim carries the engine's door id beside the place name (debt sweep Nov 3):
the director and the fsm say "bedroom door", the engine keys its doors by "door1"."""

import tempfile
import unittest

from sim import Sim


class DoorIds(unittest.TestCase):
    def test_door_event_gets_the_engine_id(self):
        s = Sim(fake=True, outdir=tempfile.mkdtemp())
        try:
            seen = []
            s._diagnostic = seen.append
            s.door_ids = {"bedroom door": "door1"}
            s._emit({"type": "door", "state": "open", "object": "bedroom door"})
            s._emit({"type": "door", "state": "open", "object": "lamp"})
            self.assertEqual(seen[0].get("id"), "door1")
            self.assertNotIn("id", seen[1])
        finally:
            s.close()

    def test_play_maps_door_places(self):
        import json
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from make import play
        d = Path(tempfile.mkdtemp())
        (d / "stage").mkdir()
        (d / "stage" / "stage.json").write_text(json.dumps({"mode": "seed", "seed": "x", "objects": []}))
        (d / "stage" / "places.json").write_text(json.dumps({"places": [
            {"name": "bedroom door", "id": "door1", "kind": "door"}, {"name": "bed", "id": "bed_1", "kind": "lie"}]}))
        got = {}

        def fake_run(**kw):
            got.update(kw)
            return None, None
        import sim
        orig = sim.seed_start
        sim.seed_start = lambda *a: ({}, [])
        try:
            play.play(d, fake=True, run=fake_run)
        finally:
            sim.seed_start = orig
        self.assertEqual(got.get("door_ids"), {"bedroom door": "door1"})


if __name__ == "__main__":
    unittest.main()
