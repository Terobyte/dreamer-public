"""Phase 1.5 contract (spec 7.2 row 1.5, the ungated Russian spike): `--lang ru`
switches the tokenizer of the repeat checks and the "English only" rules; at `en`
nothing moves -- `bank.score` on the r1 logs stays byte for byte what it was.
usage: cd h0/dream && python3 -m unittest test_phase1_lang -q
"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import bank
import bench_f1
import dialogue
import lang

HERE = os.path.dirname(os.path.abspath(__file__))

# frozen before the spike: json.dumps(bank.score(rows), sort_keys=True,
# ensure_ascii=False) of every r1 run. The spike may not move one byte of this
# at `en` (spec 7.2 row 1.5, 7.4: `vocab` never depends on _phrases at all).
R1_EN_SCORE = {
    "run_0_978509": "{\"action_loops\": 0, \"actor_lines\": 13, \"auto_touch\": 0, \"bits\": {\"Max\": [\"broken lawn chair x3\", \"that pigeon coop x3\", \"the neon sign x3\"]}, \"build\": true, \"dare_lines\": 1, \"director_fail\": 0, \"events_fired\": 0, \"events_planned\": 0, \"goal_first_line\": null, \"goals_done\": 0, \"hero_lines\": 13, \"hero_q\": \"8/13\", \"invalid\": 0, \"judge_calls\": 0, \"lines\": 26, \"lock_rejects\": 0, \"loop_cuts\": 0, \"max_actor_streak\": 1, \"max_prompt_tokens\": 0, \"remarks_per_line\": 3.15, \"repeats\": 0, \"silence_turns\": 0, \"silences_per_line\": 0.0, \"spent\": 0.1268, \"transition\": true, \"transitions\": 1, \"turn_skips\": 0, \"vocab\": 0.71, \"words_per_line\": 27.7}",
    "run_0_978510": "{\"action_loops\": 0, \"actor_lines\": 7, \"auto_touch\": 1, \"bits\": {}, \"build\": true, \"dare_lines\": 2, \"director_fail\": 0, \"events_fired\": 0, \"events_planned\": 0, \"goal_first_line\": null, \"goals_done\": 0, \"hero_lines\": 6, \"hero_q\": \"2/6\", \"invalid\": 0, \"judge_calls\": 0, \"lines\": 13, \"lock_rejects\": 0, \"loop_cuts\": 0, \"max_actor_streak\": 1, \"max_prompt_tokens\": 0, \"remarks_per_line\": 2.08, \"repeats\": 0, \"silence_turns\": 0, \"silences_per_line\": 0.0, \"spent\": 0.3732, \"transition\": true, \"transitions\": 1, \"turn_skips\": 0, \"vocab\": 0.687, \"words_per_line\": 16.2}",
    "run_0_978511": "{\"action_loops\": 11, \"actor_lines\": 19, \"auto_touch\": 1, \"bits\": {}, \"build\": true, \"dare_lines\": 1, \"director_fail\": 0, \"events_fired\": 0, \"events_planned\": 0, \"goal_first_line\": null, \"goals_done\": 0, \"hero_lines\": 18, \"hero_q\": \"9/18\", \"invalid\": 0, \"judge_calls\": 0, \"lines\": 37, \"lock_rejects\": 0, \"loop_cuts\": 0, \"max_actor_streak\": 1, \"max_prompt_tokens\": 0, \"remarks_per_line\": 3.51, \"repeats\": 1, \"silence_turns\": 0, \"silences_per_line\": 0.0, \"spent\": 0.1806, \"transition\": true, \"transitions\": 1, \"turn_skips\": 0, \"vocab\": 0.7, \"words_per_line\": 31.4}",
    "run_0_978512": "{\"action_loops\": 0, \"actor_lines\": 9, \"auto_touch\": 1, \"bits\": {}, \"build\": true, \"dare_lines\": 0, \"director_fail\": 0, \"events_fired\": 0, \"events_planned\": 0, \"goal_first_line\": null, \"goals_done\": 0, \"hero_lines\": 8, \"hero_q\": \"2/8\", \"invalid\": 0, \"judge_calls\": 0, \"lines\": 17, \"lock_rejects\": 0, \"loop_cuts\": 0, \"max_actor_streak\": 1, \"max_prompt_tokens\": 0, \"remarks_per_line\": 2.35, \"repeats\": 0, \"silence_turns\": 0, \"silences_per_line\": 0.0, \"spent\": 0.4891, \"transition\": true, \"transitions\": 1, \"turn_skips\": 0, \"vocab\": 0.745, \"words_per_line\": 16.9}",
}

RU_LINE = "[устало] Мы опять на этой крыше, и я не хочу."
RU_AGAIN = "[тихо] Опять эта крыше, и я снова не хочу."
# F3: raw tokens only, no stemming -- unrelated lines sharing one word must not repeat
RU_UNRELATED_A = "Нужен запах и король вечером"
RU_UNRELATED_B = "Нужен запас и корова утром"


class LangDefaultTest(unittest.TestCase):
    def tearDown(self):
        lang.set_lang("en")

    def test_default_is_en(self):
        self.assertEqual(lang.LANG, "en")
        self.assertEqual(lang.lang_text("Reply English only."), "Reply English only.")

    def test_unknown_lang_stays_en(self):
        lang.set_lang("de")
        self.assertEqual(lang.LANG, "en")


class ScoreUnchangedAtEnTest(unittest.TestCase):
    def tearDown(self):
        lang.set_lang("en")

    def test_lang_en_score_unchanged(self):
        lang.set_lang("en")
        for name, frozen in R1_EN_SCORE.items():
            path = os.path.join(HERE, "..", "out", "dream", "bank", name, "log.jsonl")
            if not os.path.exists(path):
                self.skipTest("r1 logs are not on this machine")
            with open(path, encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            got = json.dumps(bank.score(rows), sort_keys=True, ensure_ascii=False)
            self.assertEqual(got, frozen, name)

    def test_vocab_never_moves_with_lang(self):
        """7.4: `vocab` has its own tokenizer, so the spike cannot touch it."""
        rows = [{"type": "line", "who": "Max", "text": "[dry] The neon sign is dead again."}]
        lang.set_lang("en")
        en = bank.score(rows)["vocab"]
        lang.set_lang("ru")
        self.assertEqual(bank.score(rows)["vocab"], en)


class RuTokensTest(unittest.TestCase):
    def tearDown(self):
        lang.set_lang("en")

    def test_en_tokens_see_no_cyrillic(self):
        lang.set_lang("en")
        self.assertEqual(dialogue._phrases(RU_LINE), set())
        self.assertFalse(dialogue.repeats(RU_AGAIN, [RU_LINE]))

    def test_ru_phrases_are_cyrillic_trigrams_of_long_words(self):
        lang.set_lang("ru")
        phrases = dialogue._phrases(RU_LINE)
        self.assertTrue(phrases)
        self.assertIn("опять этой крыше", phrases)  # "мы", "на", "и", "я" are cut
        for ph in phrases:
            for w in ph.split():
                self.assertGreaterEqual(len(w), 4, ph)
        self.assertNotIn("устало", " ".join(phrases))  # remarks stay silent

    def test_ru_repeats_and_bits_catch_a_re_say(self):
        lang.set_lang("ru")
        self.assertTrue(dialogue.repeats(RU_AGAIN, [RU_LINE]))
        own = [RU_LINE, RU_LINE, RU_LINE]
        bits = dialogue.running_bits(own)
        self.assertTrue(bits)
        self.assertTrue(dialogue.uses_bit(RU_LINE, own))

    def test_ru_repeats_ignores_unrelated_lines_sharing_one_word(self):
        """F3: no stemming beyond the spec's \\w+ + 4-char cutoff -- two
        unrelated lines sharing only "нужен" must not count as a repeat."""
        lang.set_lang("ru")
        self.assertFalse(dialogue.repeats(RU_UNRELATED_B, [RU_UNRELATED_A]))

    def test_en_tokens_unchanged_for_ascii(self):
        text = "[dry] That pigeon coop is not a plan, Max."
        lang.set_lang("en")
        en = dialogue._phrases(text)
        self.assertIn("that pigeon coop", en)
        lang.set_lang("ru")
        self.assertNotEqual(dialogue._phrases(text), en)  # ru cuts "is", "not", "a"


class RuRulesTest(unittest.TestCase):
    def tearDown(self):
        lang.set_lang("en")

    def test_rules_swap_english_for_russian(self):
        import director
        lang.set_lang("ru")
        for rules in (dialogue.HERO_RULES, dialogue.ACTOR_RULES, director.DIRECTOR_SCHEMA,
                      director.LOCKED_SCHEMA, dialogue.Dialogue.JUDGE_SYSTEM):
            swapped = lang.lang_text(rules)
            self.assertNotIn("English", swapped)
            self.assertIn("Russian", swapped)

    def test_prompts_carry_the_language(self):
        from fake import FakeTransport
        from dialogue import Dialogue
        from sim import load_profile
        lang.set_lang("ru")
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=lambda *a: "[сухо] Нет."))
        self.assertNotIn("English only", dlg.hero_system())
        self.assertIn("Russian", dlg.hero_system())
        actor = dlg.actor_system("Max", {"place": "a roof"})
        self.assertNotIn("English only", actor)
        self.assertIn("Russian", actor)

    def test_director_schema_reaches_the_call_in_russian(self):
        import director
        lang.set_lang("ru")
        d = director.Director(None, fake=False)
        with mock.patch.object(director, "llm_call") as call:
            call.return_value = mock.Mock(text="{\"messages\": []}")
            d._live_decision("prompt")
        sent = call.call_args[0][2][0]["content"]
        self.assertNotIn("English", sent)
        self.assertIn("Russian", sent)


class BenchLangTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.ledger = os.path.join(self.root, "f1_ledger.jsonl")

    def tearDown(self):
        lang.set_lang("en")

    def test_gated_step_refuses_ru(self):
        """"До прохождения спайка бенч идёт по-английски": a gate is en only."""
        with mock.patch("subprocess.run", side_effect=AssertionError("no paid run allowed")):
            self.assertEqual(bench_f1.main(["--step", "1.1", "--runs", "1", "--lang", "ru",
                                            "--ledger", self.ledger, "--out", self.root]), 2)

    def test_score_respects_lang(self):
        """F2: --score --lang ru must score with the Russian tokenizer."""
        import contextlib
        import io
        rundir = tempfile.mkdtemp()
        rows = [{"type": "line", "who": "M", "text": RU_LINE},
                {"type": "line", "who": "M", "text": RU_AGAIN}]
        with open(os.path.join(rundir, "log.jsonl"), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        lang.set_lang("en")
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                rc = bench_f1.main(["--score", rundir, "--lang", "ru",
                                    "--ledger", self.ledger, "--out", self.root])
        finally:
            lang.set_lang("en")
        self.assertEqual(rc, 0)
        self.assertIn('"repeats": 1', buf.getvalue())

    def test_paid_run_scores_in_run_language(self):
        """F5: bench_f1.main's own paid path (not --score) must score the
        bank.py run in its run language -- the parent process never set_lang's
        before score_run, so a Russian run was scored with the English tokenizer."""
        rundir = tempfile.mkdtemp()
        rows = [{"type": "line", "who": "M", "role": "actor", "text": RU_LINE},
                {"type": "line", "who": "M", "role": "actor", "text": RU_AGAIN}]
        with open(os.path.join(rundir, "log.jsonl"), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        done = mock.Mock(returncode=0, stdout="run=%s\n" % rundir, stderr="")
        lang.set_lang("en")
        try:
            with mock.patch("subprocess.run", return_value=done):
                bench_f1.main(["--step", "1.5", "--runs", "1", "--lang", "ru",
                               "--ledger", self.ledger, "--out", self.root])
        finally:
            lang.set_lang("en")
        with open(self.ledger, encoding="utf-8") as f:
            entry = json.loads(f.readlines()[-1])
        self.assertEqual(entry["metrics"][0]["repeats"], 1)

    def test_spike_passes_lang_to_bank(self):
        done = mock.Mock(returncode=1, stdout="", stderr="")
        with mock.patch("subprocess.run", return_value=done) as run:
            bench_f1.main(["--step", "1.5", "--runs", "1", "--lang", "ru",
                           "--ledger", self.ledger, "--out", self.root])
        cmd = run.call_args[0][0]
        self.assertIn("--lang", cmd)
        self.assertEqual(cmd[cmd.index("--lang") + 1], "ru")


class BankSpikeCeilingTest(unittest.TestCase):
    """F4: bank.py's own budget check must honor the spike ceiling (+0.03) for
    --lang ru, not the regular one (bench_f1.py already allows the spike)."""

    def tearDown(self):
        lang.set_lang("en")

    def test_bank_allows_spike_over_regular_ceiling(self):
        root = tempfile.mkdtemp()
        sheet = os.path.join(root, "sheet.md")
        ledger = [{"dollars": round(bench_f1.CEILING - 0.19, 2)}]
        rundir = tempfile.mkdtemp()
        with open(os.path.join(rundir, "log.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "line", "who": "M", "text": RU_LINE},
                                ensure_ascii=False) + "\n")
        argv = ["bank.py", "--scenes", "roof", "--runs", "1", "--max-dollars", "0.20",
                "--lang", "ru", "--out", sheet]
        with mock.patch.object(bank, "run_scene", return_value=(rundir, "")):
            with mock.patch.object(bench_f1, "load_ledger", return_value=ledger):
                with mock.patch.object(sys, "argv", argv):
                    with mock.patch.dict(os.environ, {bank.BENCH_ENV: "1"}):
                        bank.main()  # must not sys.exit(2) refusing the spike
        self.assertTrue(os.path.exists(sheet))


class BankLangScoreTest(unittest.TestCase):
    """F1: bank.main hands --lang to the sim subprocess but scores in the
    parent process -- without set_lang the Russian run is scored English."""

    def tearDown(self):
        lang.set_lang("en")

    def test_bank_scores_in_run_language(self):
        rundir = tempfile.mkdtemp()
        rows = [{"type": "line", "who": "M", "text": RU_LINE},
                {"type": "line", "who": "M", "text": RU_AGAIN}]
        with open(os.path.join(rundir, "log.jsonl"), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        sheet = os.path.join(self.root, "sheet.md") if hasattr(self, "root") else os.path.join(rundir, "sheet.md")
        argv = ["bank.py", "--scenes", "roof", "--runs", "1", "--lang", "ru",
                "--out", sheet]
        with mock.patch.object(bank, "run_scene", return_value=(rundir, "")):
            with mock.patch.object(bench_f1, "load_ledger", return_value=[]):
                with mock.patch.object(sys, "argv", argv):
                    with mock.patch.dict(os.environ, {bank.BENCH_ENV: "1"}):
                        bank.main()
        with open(sheet, encoding="utf-8") as f:
            body = f.read()
        self.assertIn('"repeats": 1', body)


if __name__ == "__main__":
    unittest.main()
