"""make.critic on synthetic critic.jsonl: every metric, --strict exit codes, statues."""
import json
import tempfile
import unittest
import urllib.request
from pathlib import Path

from make import critic


def _no_net(*a, **k):
    raise AssertionError("network is forbidden in tests")


urllib.request.urlopen = _no_net


def fact(t, speaker="ann", plan="two", cam=(0, 1.5, 4), face=10, clear=True, head=(0, 0.3), hf=0.5, sig=None, other=None):
    acts = [{"who": "ann", "head_ndc": list(head), "height_frac": hf, "face_deg": face, "clear": clear,
             "bone_sig": t if sig is None else sig}]
    if other:
        acts.append(other)
    return {"t": t, "plan": plan, "cam": list(cam), "look": [0, 1, 0], "speaker": speaker, "actors": acts}


def good(n=20):
    return [fact(i * 0.5, plan="close" if i % 2 else "two", cam=(i, 1.5, 4)) for i in range(n)]


EVENTS = [{"ms": 0, "type": "line", "who": "ann", "dur": 4}, {"ms": 5000, "type": "line", "who": "ann", "dur": 4},
          {"ms": 9500, "type": "book_end"}]


def write(facts, events=EVENTS):
    d = Path(tempfile.mkdtemp())
    (d / "critic.jsonl").write_text("".join(json.dumps(f) + "\n" for f in facts))
    (d / "events.json").write_text(json.dumps(events))
    return d / "critic.jsonl"


class Metrics(unittest.TestCase):
    def m(self, facts, events=EVENTS, duration=None):
        return critic.analyse(facts, events, duration)

    def test_visible_share(self):
        bad = [fact(i * 0.5, face=150) if i < 10 else fact(i * 0.5) for i in range(20)]
        self.assertEqual(self.m(good())["face_visible_frac"], 1.0)
        self.assertEqual(self.m(bad)["face_visible_frac"], 0.5)

    def test_reply_without_frames_is_invisible_and_counts(self):
        f = [x for x in good() if x["t"] < 4.5]
        self.assertEqual(self.m(f)["face_visible_frac"], 0.5)

    def test_not_clear_or_out_of_frame_is_unseen(self):
        self.assertEqual(self.m([fact(i * 0.5, clear=False) for i in range(20)])["face_visible_frac"], 0)
        self.assertEqual(self.m([fact(i * 0.5, head=(1.5, 0)) for i in range(20)])["face_visible_frac"], 0)

    def test_no_dur_runs_to_next_line_or_3s(self):
        r = critic.replies([{"ms": 0, "type": "line", "who": "a"}, {"ms": 2000, "type": "line", "who": "b"},
                            {"ms": 9000, "type": "line", "who": "a"}])
        self.assertEqual([(a, b) for a, b, _ in r], [(0, 2000), (2000, 9000), (9000, 12000)])

    def test_explicit_dur_zero_is_point_interval(self):
        r = critic.replies([{"ms": 1000, "type": "line", "who": "a", "dur": 0},
                            {"ms": 2000, "type": "line", "who": "b"}])
        self.assertEqual([(a, b) for a, b, _ in r], [(1000, 1000), (2000, 5000)])

    def test_small_close_and_two(self):
        f = [fact(0, plan="close", hf=0.3), fact(0.5, plan="close", hf=0.5), fact(1, plan="two", hf=0.2)]
        m = self.m(f)
        self.assertEqual((m["close_small_frames"], m["two_small_frames"]), (1, 1))

    def test_close_counts_frame_when_any_actor_is_small(self):
        small = {"who": "bob", "head_ndc": [0.5, 0.3], "height_frac": 0.3,
                 "face_deg": 10, "clear": True, "bone_sig": 1}
        f = [fact(0, plan="close", hf=0.6, other=small)]
        self.assertEqual(self.m(f)["close_small_frames"], 1)

    def test_series(self):
        f = [fact(i, plan="close", cam=(0, 1.5, 4 + (i % 2) * 0.8)) for i in range(5)]
        self.assertEqual(self.m(f)["max_series"], 5)
        self.assertLess(self.m(good())["max_series"], 4)

    def test_back_ignores_ots(self):
        back = [fact(i * 0.5, face=170) for i in range(20)]
        self.assertEqual(self.m(back)["back_frac"], 1.0)
        ots = [fact(i * 0.5, face=170, plan="ots") for i in range(20)]
        self.assertEqual(self.m(ots)["back_frac"], 0.0)

    def test_overlap(self):
        o = {"who": "bob", "head_ndc": [0, 0.3], "height_frac": 0.5, "face_deg": 10, "clear": True, "bone_sig": 1}
        self.assertEqual(self.m([fact(0, other=o)])["overlap_frames"], 1)
        self.assertEqual(self.m(good())["overlap_frames"], 0)

    def test_explicit_overlap_flag_wins_over_head_projection(self):
        # runtime says no overlap (overlap: false) while heads project together:
        # NDC closeness alone must not count as body overlap (F9)
        o = {"who": "bob", "head_ndc": [0, 0.3], "height_frac": 0.5, "face_deg": 10, "clear": True, "bone_sig": 1}
        f = dict(fact(0, other=o), overlap=False)
        self.assertEqual(self.m([f])["overlap_frames"], 0)
        f2 = dict(fact(0, other=o), overlap=True)
        self.assertEqual(self.m([f2])["overlap_frames"], 1)

    def test_unknown_duration_is_gaps(self):
        # no video length (no --duration, no sibling video): completeness is unverifiable (F8)
        self.assertTrue(self.m(good())["CRITIC_GAPS"])

    def test_statue(self):
        still = [fact(i * 0.5, sig=1.0) for i in range(4)]
        moving = [fact(i * 0.5, sig=1.0 + (i % 2) * 0.01) for i in range(4)]
        self.assertEqual(self.m(still)["statues"], ["ann"])
        self.assertEqual(self.m(moving)["statues"], [])


class Strict(unittest.TestCase):
    def test_good_zero_bad_three(self):
        # good facts span 9.5 s of a 10 s video: 20 facts >= 80% of 10/0.5 and no line runs past them
        self.assertEqual(critic.run(write(good()), strict=True, duration=10), 0)
        bad = [fact(i * 0.5, face=150) for i in range(20)]
        self.assertEqual(critic.run(write(bad), strict=True), 3)

    def test_without_strict_only_summary(self):
        p = write([fact(i * 0.5, face=150) for i in range(20)])
        self.assertEqual(critic.run(p), 0)
        self.assertTrue((p.parent / "critic.json").exists())

    def test_empty_file_and_no_lines_are_3(self):
        self.assertEqual(critic.run(write([]), strict=True), 3)
        self.assertEqual(critic.run(write(good(), events=[{"ms": 0, "type": "book_end"}]), strict=True), 3)

    def test_series_of_four_is_3(self):
        f = [fact(i * 0.5, plan="close", cam=(0, 1.5, 4 + (i % 2) * 0.8)) for i in range(20)]
        self.assertEqual(critic.run(write(f), strict=True), 3)

    def test_gaps_are_4(self):
        self.assertEqual(critic.run(write(good(20)), strict=True, duration=60), 4)
        sparse = good(20)[:8]
        self.assertEqual(critic.run(write(sparse, events=[{"ms": 0, "type": "line", "who": "ann", "dur": 8}]), strict=True), 4)  # the second line runs past the last fact


class WrittenFactsJudged(unittest.TestCase):
    """L172: shot_clamped, bed_saw and dcut were written by the runtime and never read."""

    def test_hanging_head_over_the_bed_is_bad(self):
        f = good()
        f[3]["bed_saw"] = {"who": "ann", "head": [0, 1.2, 0], "under": 0.6, "base": 0.5, "foot": [0, 0], "shift": 0, "t": 1}
        m = critic.analyse(f, EVENTS, 10)
        self.assertAlmostEqual(m["bed_float_m"], 0.6)
        self.assertEqual(critic.verdict(m), 3)
        f[3]["bed_saw"]["head"][1] = 0.75
        self.assertEqual(critic.verdict(critic.analyse(f, EVENTS, 10)), 0)

    def test_clamped_plan_frames(self):
        f = good()
        for x in f:
            x["shot"] = "s1"
        for x in f[:3]:
            x["shot_clamped"] = True
        m = critic.analyse(f, EVENTS, 10)
        self.assertEqual((m["clamped_frames"], m["plan_frames"]), (3, 20))
        self.assertEqual(critic.verdict(m), 0)
        for x in f[:10]:
            x["shot_clamped"] = True
        self.assertEqual(critic.verdict(critic.analyse(f, EVENTS, 10)), 3)

    def test_director_mean_plan(self):
        f = good()
        for i, x in enumerate(f):
            x["dcut"] = i // 5
        m = critic.analyse(f, EVENTS, 10)
        self.assertAlmostEqual(m["director_asl_s"], 9.5 / 4, places=2)
        self.assertIn("director mean plan", critic.summary(m))
        self.assertIsNone(critic.analyse(good(), EVENTS, 10)["director_asl_s"])


class TestShotsDcut(unittest.TestCase):
    """r11: the runtime writes `dcut` (or `shot`) per fact; without them the old heuristic stays."""

    def test_r11_same_plan_different_dcut_is_two_shots(self):
        f = [dict(fact(i * 0.5, plan="close"), dcut=0 if i < 3 else 1) for i in range(6)]
        self.assertEqual([len(s) for s in critic.shots(f)], [3, 3])

    def test_r11_camera_move_inside_dcut_does_not_cut(self):
        f = [dict(fact(i * 0.5, plan="close", cam=(i * 5, 1.5, 4)), dcut=7) for i in range(4)]
        self.assertEqual([len(s) for s in critic.shots(f)], [4])

    def test_r11_shot_field_groups_when_no_dcut(self):
        f = [dict(fact(i * 0.5, plan="close"), shot=i // 2) for i in range(4)]
        self.assertEqual([len(s) for s in critic.shots(f)], [2, 2])

    def test_r11_old_format_unchanged(self):
        f = [fact(0, plan="close"), fact(0.5, plan="close", cam=(9, 1.5, 4)), fact(1, plan="two", cam=(9, 1.5, 4))]
        self.assertEqual([len(s) for s in critic.shots(f)], [1, 1, 1])
        g = [fact(0, plan="close"), fact(0.5, plan="close")]
        self.assertEqual([len(s) for s in critic.shots(g)], [2])


if __name__ == "__main__":
    unittest.main()
