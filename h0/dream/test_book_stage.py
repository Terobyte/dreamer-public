import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from book import score_scene, load_book


class TestBookStage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.koshakan_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "books", "koshakan")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_koshakan_bedroom_staging(self):
        """спальня Кошакана -> start Мирай bed/lie, Мама offstage; бит «Мама входит» -> enter"""
        places = {
            "bed": {"room": "bedroom", "poses": ["lie", "sit"]},
            "door_bedroom": {"room": "bedroom", "poses": ["stand"]},
            "sink": {"room": "bathroom", "poses": ["stand"]}
        }
        calls = []

        def fake_director(prompt):
            calls.append(prompt)
            return json.dumps({
                "start": [
                    {"who": "Мирай", "place": "bed", "pose": "lie"},
                    {"who": "Мама", "place": "door_bedroom", "pose": "stand", "offstage": True}
                ],
                "stage": [
                    {"beat_id": 0, "who": "Мирай", "action": "stay"},
                    {"beat_id": 1, "who": "Мама", "action": "enter", "place": "door_bedroom"}
                ]
            })

        score = score_scene(self.koshakan_dir, "bedroom_morning", places=places, director=fake_director)
        self.assertEqual(len(calls), 1)
        self.assertIn("start", score)
        mirai_start = next(s for s in score["start"] if s["who"] == "Мирай")
        mama_start = next(s for s in score["start"] if s["who"] == "Мама")
        self.assertEqual(mirai_start["place"], "bed")
        self.assertEqual(mirai_start["pose"], "lie")
        self.assertTrue(mama_start.get("offstage"))

        # beat enter
        beats_with_stage = [b for b in score["beats"] if b.get("stage")]
        self.assertTrue(len(beats_with_stage) > 0)
        mama_stage = next(st for b in beats_with_stage for st in b["stage"] if st["who"] == "Мама")
        self.assertEqual(mama_stage["action"], "enter")
        self.assertEqual(mama_stage["place"], "door_bedroom")

    def test_invalid_place_and_pose(self):
        """место moon -> stay и предупреждение; lie на раковине -> stand"""
        places = {
            "sink": {"room": "bathroom", "poses": ["stand"]},
            "bed": {"room": "bedroom", "poses": ["lie", "sit"]}
        }

        def fake_director(prompt):
            return json.dumps({
                "start": [
                    {"who": "Мирай", "place": "sink", "pose": "lie"}
                ],
                "stage": [
                    {"beat_id": 0, "who": "Мирай", "action": "goto", "place": "moon"}
                ]
            })

        score = score_scene(self.koshakan_dir, "bedroom_morning", places=places, director=fake_director)
        mirai_start = next(s for s in score["start"] if s["who"] == "Мирай")
        # lie on sink is not in poses of sink -> stand
        self.assertEqual(mirai_start["pose"], "stand")

        # beat 0 had goto moon -> moon is not in places -> stay with warning
        beat0 = score["beats"][0]
        self.assertEqual(beat0["stage"][0]["action"], "stay")
        self.assertTrue(any("moon" in w or "place" in w for w in score.get("warnings", [])))

    def test_hand_edited_book_no_model_called(self):
        """ручной start в book.json -> модель не вызвана"""
        temp_book_dir = os.path.join(self.tmp, "book")
        shutil.copytree(self.koshakan_dir, temp_book_dir)
        book_json_path = os.path.join(temp_book_dir, "book.json")
        with open(book_json_path, encoding="utf-8") as f:
            data = json.load(f)

        # specify full start and stage for all beats in scene
        for ch in data["chapters"]:
            for sc in ch["scenes"]:
                if sc["id"] == "bedroom_morning":
                    sc["start"] = [{"who": "Мирай", "place": "bed", "pose": "lie"}]
                    sc["stage"] = {
                        "0": [{"who": "Мирай", "action": "stay"}]
                    }

        with open(book_json_path, "w", encoding="utf-8") as f:
            json.dump(data, f)

        called = []

        def fake_director(prompt):
            called.append(prompt)
            return "{}"

        score = score_scene(temp_book_dir, "bedroom_morning", director=fake_director)
        self.assertEqual(len(called), 0)
        self.assertEqual(score["start"][0]["who"], "Мирай")
        self.assertEqual(score["start"][0]["place"], "bed")

    def test_broken_json_retry(self):
        """битый JSON -> один повтор того же вызова, потом сцена без постановки и предупреждение"""
        calls = []

        def fake_director(prompt):
            calls.append(prompt)
            return "broken { json"

        score = score_scene(self.koshakan_dir, "bedroom_morning", places={"bed": {"room": "bedroom", "poses": ["lie"]}}, director=fake_director)
        self.assertEqual(len(calls), 2)
        self.assertTrue(any("JSON" in w or "director" in w or "broken" in w or "failed" in w for w in score.get("warnings", [])))

    def test_sim_step_stage_e2e(self):
        """сквозной красный тест: бит со stage из score.json -> _book_step -> событие рантайма"""
        from sim import Sim

        score_data = {
            "scene_id": "bedroom_morning",
            "start": [{"who": "Мирай", "place": "bed", "pose": "lie"}],
            "beats": [
                {
                    "id": 0,
                    "text": "Мама заходит в комнату.",
                    "stage": [{"who": "Мама", "action": "enter", "place": "door_bedroom"}],
                    "line": {"who": "Мама", "text": "Доброе утро!", "remarks": "smiling"}
                }
            ]
        }
        sim = Sim(mode="book")
        plan = sim._load_book_plan(score_data)
        self.assertIn("start", plan)
        self.assertEqual(plan["start"][0]["who"], "Мирай")
        self.assertEqual(plan["beats"][0]["stage"][0]["action"], "enter")

        # Check scene open sends start events
        open_events = sim._book_open_scene("bedroom_morning", plan)
        start_events = [e for e in open_events if e.get("type") == "start"]
        self.assertTrue(len(start_events) > 0)
        self.assertEqual(start_events[0]["who"], "Мирай")
        self.assertEqual(start_events[0]["place"], "bed")
        self.assertEqual(start_events[0]["pose"], "lie")

        # Check step sends stage before line, remarks preserved in line
        step_events = sim._book_step()
        stage_events = [e for e in step_events if e.get("type") == "stage"]
        line_events = [e for e in step_events if e.get("type") == "line"]
        self.assertTrue(len(stage_events) > 0)
        self.assertEqual(stage_events[0]["who"], "Мама")
        self.assertEqual(stage_events[0]["action"], "enter")
        self.assertEqual(stage_events[0]["place"], "door_bedroom")
        self.assertTrue(len(line_events) > 0)
        self.assertEqual(line_events[0]["who"], "Мама")
        self.assertEqual(line_events[0]["remarks"], "smiling")

        # Changing scene applies start again
        next_score = {
            "scene_id": "bathroom_wash",
            "start": [{"who": "Мирай", "place": "sink", "pose": "stand"}],
            "beats": []
        }
        next_plan = sim._load_book_plan(next_score)
        next_open_events = sim._book_open_scene("bathroom_wash", next_plan)
        next_start = [e for e in next_open_events if e.get("type") == "start"]
        self.assertTrue(len(next_start) > 0)
        self.assertEqual(next_start[0]["place"], "sink")


if __name__ == "__main__":
    unittest.main()
