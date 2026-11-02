"""N10 staging contract: fake director, real Koshakan book and book runtime."""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import book
import sim as S

HERE = os.path.dirname(os.path.abspath(__file__))
KOSHAKAN = os.path.join(HERE, "books", "koshakan")


class TestBookStage(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.tmp = tempfile.mkdtemp(prefix="book-stage-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        S.use_scene("start")

    def _places(self):
        return {
            "bed": {"room": "bedroom", "poses": ["lie", "sit", "stand"]},
            "door_bedroom": {"room": "bedroom", "poses": ["stand"]},
            "sink": {"room": "bathroom", "poses": ["stand"]},
            "door_bathroom": {"room": "bathroom", "poses": ["stand"]},
        }

    def _director(self, response):
        calls = []

        def fake_director(prompt):
            calls.append(prompt)
            return response

        return fake_director, calls

    def test_koshakan_bedroom_start_and_mama_enters(self):
        """Real bedroom beat 2 is Mama bending down to Mirai; place her at the door first."""
        response = {
            "start": [
                {"who": "Mirai", "place": "bed", "pose": "lie"},
                {"who": "Mama", "place": "door_bedroom", "pose": "stand", "offstage": True},
            ],
            # In bedroom, beat 2 is the actual narration: "Mama bent down and whispered..."
            "stage": [
                {"beat_id": 2, "who": "Mama", "action": "enter", "place": "door_bedroom"},
            ],
        }
        director, calls = self._director(json.dumps(response))
        score = book.score_scene(KOSHAKAN, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)

        self.assertEqual(len(calls), 1)
        mirai = next(x for x in score["start"] if x["who"] == "Mirai")
        mama = next(x for x in score["start"] if x["who"] == "Mama")
        self.assertEqual((mirai["place"], mirai["pose"]), ("bed", "lie"))
        self.assertEqual(mama["place"], "door_bedroom")
        self.assertTrue(mama["offstage"])
        beat = score["beats"][2]
        self.assertIn("Mama bent down", beat["text"])
        self.assertEqual(beat["stage"], [
            {"who": "Mama", "action": "enter", "place": "door_bedroom"}
        ])

    def test_unknown_place_falls_back_to_stay_with_beat_id_warning(self):
        director, _ = self._director(json.dumps({
            "stage": [{"beat_id": 2, "who": "Mama", "action": "goto", "place": "moon"}]
        }))
        score = book.score_scene(KOSHAKAN, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)
        self.assertEqual(score["beats"][2]["stage"][0]["action"], "stay")
        self.assertTrue(any("2" in warning and "moon" in warning
                            for warning in score["warnings"]))

    def test_pose_not_available_at_sink_falls_back_to_stand(self):
        director, _ = self._director(json.dumps({
            "start": [{"who": "Mirai", "place": "sink", "pose": "lie"}]
        }))
        score = book.score_scene(KOSHAKAN, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)
        mirai = next(x for x in score["start"] if x["who"] == "Mirai")
        self.assertEqual(mirai["pose"], "stand")

    def test_stage_places_json_envelope_is_accepted_and_prompt_lists_bank(self):
        calls = []
        response = json.dumps({"start": [{"who": "Mirai", "place": "bed", "pose": "lie"}],
                               "stage": [{"beat_id": 2, "who": "Mama", "action": "goto",
                                          "place": "bed", "pose": "lie"},
                                         {"beat_id": 2, "who": "Mirai", "action": "goto",
                                          "place": "door_bedroom", "pose": "lie"}]})
        director, _ = self._director(response)
        # Match h0/make/stage.py's persisted stage/places.json shape.
        bank = {"places": [{"name": "bed", "room": "bedroom", "poses": ["lie", "sit", "stand"]},
                           {"name": "door_bedroom", "room": "bedroom", "poses": ["stand"]}],
                "warnings": []}
        def recording(prompt):
            calls.append(prompt)
            return director(prompt)
        score, failure = None, None
        try:
            score = book.score_scene(KOSHAKAN, "bedroom", places=bank, director=recording,
                                     cache_dir=self.tmp)
        except Exception as exc:
            failure = exc
        self.assertIsNone(failure, f"score_scene should accept the stage/places.json envelope: {failure!r}")
        self.assertEqual(len(calls), 1)
        self.assertIn("bed", calls[0])
        stage = score["beats"][2]["stage"]
        self.assertEqual(stage[0]["place"], "bed")
        self.assertEqual(stage[0]["pose"], "lie")
        mirai_stage = next(item for item in stage if item["who"] == "Mirai")
        self.assertEqual(mirai_stage["place"], "door_bedroom")
        self.assertEqual(mirai_stage["pose"], "stand")

    def test_explicit_empty_manual_fields_override_director_individually(self):
        target, path, data, scene = self._copy_book_with_scene()
        scene["start"] = []
        scene["stage"] = {}
        self._write_book(path, data)
        director, calls = self._director(json.dumps({
            "start": [{"who": "Mirai", "place": "bed", "pose": "lie"}],
            "stage": [{"beat_id": 2, "who": "Mama", "action": "enter", "place": "door_bedroom"}],
        }))
        score = book.score_scene(target, "bedroom", places=self._places(), director=director,
                                 cache_dir=self.tmp)
        self.assertEqual(calls, [])
        self.assertEqual(score["start"], [])
        self.assertTrue(all(not b.get("stage") for b in score["beats"]))

    def test_empty_manual_start_still_calls_director_when_stage_is_missing(self):
        target, path, data, scene = self._copy_book_with_scene()
        scene["start"] = []
        self._write_book(path, data)
        director, calls = self._director(json.dumps({
            "start": [{"who": "Mirai", "place": "bed", "pose": "lie"}],
            "stage": [{"beat_id": 2, "who": "Mama", "action": "enter", "place": "door_bedroom"}],
        }))
        score = book.score_scene(target, "bedroom", places=self._places(), director=director,
                                 cache_dir=self.tmp)
        self.assertEqual(len(calls), 1)
        self.assertEqual(score["start"], [])
        self.assertEqual(score["beats"][2]["stage"][0]["action"], "enter")

    def _copy_book_with_scene(self):
        target = os.path.join(self.tmp, "book")
        shutil.copytree(KOSHAKAN, target)
        path = os.path.join(target, "book.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        scene = next(s for c in data["chapters"] for s in c["scenes"]
                     if s["id"] == "bedroom")
        return target, path, data, scene

    def _write_book(self, path, data):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    def test_manual_start_and_stage_skip_model(self):
        target, path, data, scene = self._copy_book_with_scene()
        scene["start"] = [{"who": "Mirai", "place": "bed", "pose": "lie"}]
        # Beat ids are indices into score["beats"].
        scene["stage"] = {"2": [{"who": "Mama", "action": "stay"}]}
        self._write_book(path, data)
        director, calls = self._director("{}")

        score = book.score_scene(target, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)
        self.assertEqual(calls, [])
        self.assertEqual(score["start"], scene["start"])
        self.assertEqual(score["beats"][2]["stage"], scene["stage"]["2"])

    def test_manual_start_wins_while_missing_stage_is_generated(self):
        target, path, data, scene = self._copy_book_with_scene()
        scene["start"] = [{"who": "Mirai", "place": "bed", "pose": "sit"}]
        director, calls = self._director(json.dumps({
            "start": [{"who": "Mirai", "place": "sink", "pose": "stand"}],
            "stage": [{"beat_id": 2, "who": "Mama", "action": "enter",
                       "place": "door_bedroom"}],
        }))
        self._write_book(path, data)

        score = book.score_scene(target, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)
        self.assertEqual(len(calls), 1)
        self.assertEqual(score["start"][0]["pose"], "sit")
        self.assertEqual(score["beats"][2]["stage"][0]["action"], "enter")

    def test_broken_json_retries_once_then_has_no_staging(self):
        director, calls = self._director("broken { json")
        score = book.score_scene(KOSHAKAN, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("start", score)
        self.assertFalse(any(beat.get("stage") for beat in score["beats"]))
        self.assertTrue(any("retry" in warning.lower() or "failed" in warning.lower()
                            for warning in score["warnings"]))

    def test_unknown_who_is_dropped_with_warning_and_beat_id(self):
        director, _ = self._director(json.dumps({
            "stage": [{"beat_id": 3, "who": "Visitor", "action": "enter",
                       "place": "door_bedroom"}]
        }))
        score = book.score_scene(KOSHAKAN, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)
        self.assertFalse(score["beats"][3].get("stage"))
        self.assertTrue(any("3" in warning and "Visitor" in warning
                            for warning in score["warnings"]))

    def test_unknown_action_becomes_stay(self):
        director, _ = self._director(json.dumps({
            "stage": [{"beat_id": 2, "who": "Mama", "action": "teleport"}]
        }))
        score = book.score_scene(KOSHAKAN, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)
        self.assertEqual(score["beats"][2]["stage"][0]["action"], "stay")
        self.assertTrue(any("2" in warning and "teleport" in warning
                            for warning in score["warnings"]))

    def test_unknown_look_is_removed_with_warning(self):
        director, _ = self._director(json.dumps({
            "stage": [{"beat_id": 2, "who": "Mama", "action": "stay",
                       "look": "the moon"}]
        }))
        score = book.score_scene(KOSHAKAN, "bedroom", places=self._places(),
                                 director=director, cache_dir=self.tmp)
        self.assertNotIn("look", score["beats"][2]["stage"][0])
        self.assertTrue(any("2" in warning and "the moon" in warning
                            for warning in score["warnings"]))

    @staticmethod
    def _score(scene, beats, start):
        return {"scene": scene, "place": scene, "cast": ["Mirai", "Mama"],
                "start": start, "beats": beats}

    def test_score_runs_through_book_events_and_scene_change(self):
        """Use score -> real plan loader -> Sim diagnostics for start, stage and line."""
        bedroom = self._score("bedroom", [{
            "id": 0, "kind": "line", "who": "Mama", "text": "Wake up.",
            "stage": [{"who": "Mama", "action": "enter", "place": "door_bedroom"}],
            "remarks": "smiling",
        }], [{"who": "Mirai", "place": "bed", "pose": "lie"}])
        bathroom = self._score("bathroom", [{
            "id": 0, "kind": "line", "who": "Mama", "text": "Wash up.",
        }], [{"who": "Mirai", "place": "sink", "pose": "stand"}])
        score_path = os.path.join(self.tmp, "score.json")
        with open(score_path, "w", encoding="utf-8") as f:
            json.dump([bedroom, bathroom], f)
        plan = S._load_book_plan(KOSHAKAN, ["bedroom", "bathroom"], score_path)
        S.use_scene(plan["scenes"][0]["dict"])
        sim = S.Sim(profile=None, fake=True, speed=1.0, outdir=self.tmp,
                    book=plan, script=[])
        self.addCleanup(sim.close)

        log_path = os.path.join(self.tmp, "log.jsonl")

        def rows():
            with open(log_path, encoding="utf-8") as f:
                return [json.loads(line) for line in f if line.strip()]

        initial = rows()
        start0 = next(i for i, event in enumerate(initial)
                      if event["type"] == "start" and event["place"] == "bed")

        sim._book_step()
        played = rows()
        stage_i = next(i for i, event in enumerate(played)
                       if event["type"] == "stage" and event.get("action") == "enter")
        line_i = next(i for i, event in enumerate(played)
                      if event["type"] == "line" and event.get("text") == "Wake up.")
        self.assertLess(start0, stage_i)
        self.assertLess(stage_i, line_i)
        self.assertEqual(played[line_i]["remarks"], "smiling")

        sim._book_scene_end()  # advance the real book transition and open bathroom
        switched = rows()
        bathroom_start = next(i for i, event in enumerate(switched)
                              if event["type"] == "start" and event["place"] == "sink")
        transition = next(i for i, event in enumerate(switched)
                          if event["type"] == "transition" and event["scene"] == "bathroom")
        self.assertGreater(bathroom_start, transition)


if __name__ == "__main__":
    unittest.main()
