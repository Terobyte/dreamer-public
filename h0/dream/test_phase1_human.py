"""Bench r2, step Ч1: the humanness signals of human.py over synthetic logs.

Offline. Each metric is a share or a per-line rate over the `line` rows; the
thresholds live in bench_f1.GATES["Ч1"] and are the owner's bar, not the code's.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_f1  # noqa: E402
import human  # noqa: E402


def line(who, text, role="actor"):
    return {"type": "line", "who": who, "text": text, "role": role}


class HumanScoreTest(unittest.TestCase):
    def test_empty_log_is_all_none(self):
        m = human.score_human([{"type": "cost", "dollars": 0.1}])
        self.assertEqual(set(m), set(human.KEYS))
        self.assertTrue(all(v is None for v in m.values()), m)

    def test_question_share_counts_lines_ending_with_a_question(self):
        rows = [line("Dan", "[soft] Are you okay?"), line("Max", "[flat] No."),
                line("Dan", "[tense] Come here, please? [pause]"), line("Max", "[low] Stop.")]
        # the tag after the question mark does not hide it
        self.assertEqual(human.score_human(rows)["q_share"], 0.5)

    def test_name_share_counts_the_other_speakers_name_only(self):
        rows = [line("Dan", "Max, stay."), line("Max", "Maya called."),
                line("Dan", "Maxwell is not you."), line("Max", "Dan.")]
        # Maya is not a speaker; Maxwell is not Max (whole word)
        self.assertEqual(human.score_human(rows)["name_share"], 0.5)

    def test_short_share_and_length_spread(self):
        rows = [line("Dan", "[gasp] No."), line("Max", "I lost the warehouse job on Friday."),
                line("Dan", "What."), line("Max", "<whisper>Don't</whisper> tell her.")]
        m = human.score_human(rows)
        # "No." and "What." are short; "Don't tell her" is three words
        self.assertEqual(m["short_share"], 0.75)
        self.assertGreater(m["len_cv"], 0.5)
        flat = [line("Dan", "one two three four five")] * 4
        self.assertEqual(human.score_human(flat)["len_cv"], 0.0)

    def test_cliche_rate(self):
        rows = [line("Dan", "[soft] I'm right here, I promise."),
                line("Max", "[flat] The neon hums."),
                line("Dan", "Thank you for telling me. You're not alone.")]
        # 2 + 0 + 2 = 4 hits over 3 lines
        self.assertAlmostEqual(human.score_human(rows)["cliche_per_line"], 4 / 3, places=3)

    def test_agree_opener_share(self):
        rows = [line("Dan", "[soft] Okay, I'll sit."), line("Max", "Of course she does."),
                line("Dan", "The chair squeaks."), line("Max", "[low] yeah.")]
        self.assertEqual(human.score_human(rows)["agree_open_share"], 0.75)

    def test_pause_rate(self):
        rows = [line("Dan", "[pause] one [pause] two"), line("Max", "[long pause] three"),
                line("Dan", "four")]
        # [long pause] is a remark of its own, not the bare [pause] tic
        self.assertAlmostEqual(human.score_human(rows)["pause_per_line"], 2 / 3, places=3)

    def test_opener_repeat_share(self):
        rows = [line("Dan", "One, two, three steps."), line("Max", "[flat] Just stay."),
                line("Dan", "[frantic] One two again?"), line("Max", "Just stay here."),
                line("Dan", "Let it ring.")]
        # "one two" and "just stay" each open a second line: 2 of 5
        self.assertEqual(human.score_human(rows)["opener_rep_share"], 0.4)

    def test_echo_and_idiolect_are_informational(self):
        rows = [line("Dan", "the warehouse job is gone"), line("Max", "the warehouse job, yes"),
                line("Dan", "pigeons sleep")]
        m = human.score_human(rows)
        # (0.5 with the echo line + 0 with the fresh one) / 2
        self.assertEqual(m["echo_prev"], 0.25)
        self.assertLessEqual(m["idiolect"], 1.0)
        for k in ("echo_prev", "idiolect"):
            self.assertFalse(any(r[0] == k for r in bench_f1.GATES["Ч1"]), k)


class HumanGateTest(unittest.TestCase):
    def test_gate_rules_name_real_metrics(self):
        for rule in bench_f1.GATES["Ч1"]:
            self.assertTrue(rule[0] in human.KEYS or rule[0] in bench_f1.CRAFT_KEYS, rule)

    def test_score_run_carries_the_human_metrics(self):
        import json
        import tempfile
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "log.jsonl"), "w", encoding="utf-8") as f:
            for r in (line("Dan", "[soft] Max?"), line("Max", "[flat] No.", "hero")):
                f.write(json.dumps(r) + "\n")
        m = bench_f1.score_run(d)
        self.assertEqual(m["q_share"], 0.5)
        self.assertEqual(m["lines"], 2)


if __name__ == "__main__":
    unittest.main()
