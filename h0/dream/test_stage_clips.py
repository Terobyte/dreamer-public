# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
"""Koshakan meadow, Nov 3: Spark staged every beat "stay"; the run, the fall, the lap never played. The engine picked
clips by single words of the text and the cast verbs are phrases ("sat down", "climbs into lap"), "ran" is in no list.
The director now sees the beats by id and each actor's clips, and names the clip a beat plays."""
import json
import unittest

from stage_director import build_director_prompt, validate_and_merge_staging

PLACES = {"m022": {"room": "meadow", "poses": ["stand_at"]}}
CLIPS = {"Mirai": ["run_joy", "lap_cloud", "stand_idle"], "Mama": ["sit_down_grass", "lap_hold"]}
BEATS = [{"id": 0, "kind": "narration", "text": "Mirai ran, and ran."},
         {"id": 1, "kind": "line", "who": "Mama", "text": "Run, Koshakanym!"}]


def _merge(stage, warnings):
    return validate_and_merge_staging({"start": [], "stage": stage}, [], ["Mirai", "Mama"], PLACES, None, {},
                                      warnings, clips=CLIPS)[1]


class StageClips(unittest.TestCase):
    def test_prompt_lists_beats_by_id_and_clips(self):
        p = json.loads(build_director_prompt(["p"], ["Mirai", "Mama"], PLACES, beats=BEATS, clips=CLIPS))
        self.assertEqual([b["id"] for b in p["beats"]], [0, 1])
        self.assertEqual(p["beats"][1]["who"], "Mama")
        self.assertEqual(p["clips"], CLIPS)
        self.assertIn("clip", p["instruction"])

    def test_a_known_clip_is_kept_with_its_idle(self):
        w = []
        st = _merge([{"beat_id": 0, "who": "Mirai", "action": "stay", "clip": "run_joy", "idle": "stand_idle"}], w)
        self.assertEqual(st[0][0]["clip"], "run_joy")
        self.assertEqual(st[0][0]["idle"], "stand_idle")

    def test_another_actors_clip_is_dropped(self):
        w = []
        st = _merge([{"beat_id": 0, "who": "Mirai", "action": "stay", "clip": "sit_down_grass"}], w)
        self.assertNotIn("clip", st[0][0])
        self.assertTrue(any("sit_down_grass" in x for x in w))

    def test_go_to_another_actor(self):
        w = []
        st = _merge([{"beat_id": 1, "who": "Mirai", "action": "goto", "place": "Mama", "clip": "lap_cloud"}], w)
        self.assertEqual(st[1][0]["action"], "goto")
        self.assertEqual(st[1][0]["place"], "Mama")

    def test_go_to_oneself_stays(self):
        w = []
        st = _merge([{"beat_id": 1, "who": "Mirai", "action": "goto", "place": "Mirai"}], w)
        self.assertEqual(st[1][0]["action"], "stay")


class ScoreSceneClips(unittest.TestCase):
    def test_score_scene_asks_with_beats_and_clips_and_keeps_the_clip(self):
        import os
        import book
        kosh = os.path.join(os.path.dirname(os.path.abspath(__file__)), "books", "koshakan")
        asked = []

        def director(prompt):
            asked.append(json.loads(prompt))
            return json.dumps({"start": [], "stage": [{"beat_id": 0, "who": "Mirai", "action": "stay", "clip": "run_joy"}]})
        sc = book.score_scene(kosh, "meadow", places=PLACES, director=director, clips=CLIPS)
        self.assertEqual(asked[0]["beats"][0]["id"], 0)
        self.assertEqual(asked[0]["clips"], CLIPS)
        self.assertEqual(sc["beats"][0]["stage"][0]["clip"], "run_joy")

    def test_start_keeps_a_known_idle(self):
        # Squidward, Nov 3: "Squidward stood at his easel and painted" opened the film, the start had no clip, he stood
        w = []
        start = validate_and_merge_staging(
            {"start": [{"who": "Mirai", "place": "m022", "pose": "stand_at", "idle": "stand_idle"},
                       {"who": "Mama", "place": "m022", "pose": "stand_at", "idle": "run_joy"}], "stage": []},
            [], ["Mirai", "Mama"], PLACES, None, {}, w, clips=CLIPS)[0]
        self.assertEqual(start[0]["idle"], "stand_idle")
        self.assertNotIn("idle", start[1])
        self.assertTrue(any("run_joy" in x for x in w))

    def test_prompt_offers_idle_at_start(self):
        p = json.loads(build_director_prompt(["p"], ["Mirai", "Mama"], PLACES, beats=BEATS, clips=CLIPS))
        self.assertIn("start: [{who, place, pose, offstage?: bool, idle?}]", p["instruction"])
