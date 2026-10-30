"""Red tests for the K-block review findings F1-F4, F6-F7 (tester round).
usage: cd h0/dream && python3 -m unittest -q test_kfix
F5 (comic whisper) is UI-only and verified by reading the code.
"""
import glob
import json
import os
import tempfile
import time
import unittest

import book as B
import sim as S

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK = os.path.join(HERE, "books", "gwtw")


def rows_of(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def make_sim(scene="library", hero_owner=None, speed=1.0):
    plan = S._load_book_plan(BOOK, [scene])
    S.use_scene(plan["scenes"][0]["dict"])
    sim = S.Sim(profile=None, fake=True, speed=speed, outdir=tempfile.mkdtemp(),
                book=plan, script=[], hero_owner=hero_owner)
    return sim, plan


class FixTest(unittest.TestCase):
    def tearDown(self):
        S.use_scene("start")

    def test_f1_two_names_keep_previous_speaker(self):
        scene = {"id": "x", "paras": [0, 3], "cast": ["Alice A", "Bob B"],
                 "aliases": {"Alice": "Alice A", "Bob": "Bob B"}}
        book = {"cast": {"Alice A": {"sex": "woman"}, "Bob B": {"sex": "man"}}}
        text = ('"Hello," said Bob.\n\n'
                'Alice and Bob waited on the lawn quietly.\n\n'
                '"Go now, quickly, please, friend."')
        beats = B.parse_scene(text, scene, book)
        lines = [b for b in beats if b["kind"] == "line"]
        self.assertEqual(lines[0]["who"], "Bob B")
        self.assertEqual(lines[1]["who"], "Bob B")

    def test_f2_post_event_starts_no_consult(self):
        sim, _ = make_sim(speed=50)
        self.addCleanup(sim.close)
        sim.post_event({"source": "tool", "value": "ping"})
        time.sleep(0.5)
        rows = rows_of(os.path.join(sim.outdir, "log.jsonl"))
        self.assertEqual([r for r in rows if r["type"] == "consult"], [])
        self.assertEqual(glob.glob(os.path.join(sim.outdir, "consults", "*.txt")), [])

    def test_f3_narration_carries_narrator_voice(self):
        plan = S._load_book_plan(BOOK, ["library"])
        out, log = S.run(book=BOOK, fake=True, speed=50, scenes=["library"])
        rows = rows_of(log)
        narr = [r for r in rows if r["type"] == "narrator" and r.get("cause") == "book"]
        self.assertTrue(narr)
        for r in narr:
            self.assertEqual(r.get("voice"), plan["narrator_voice"])

    def test_f4_human_answer_fulfills_pov_beat(self):
        rows = [{"type": "book", "scene": "x",
                 "beats": [{"kind": "line", "who": "H", "text": "T1"},
                           {"kind": "line", "who": "A", "text": "T2"}]},
                {"type": "line", "source": "human", "who": "H", "text": "HX"},
                {"type": "line", "source": "book", "who": "A", "text": "T2"}]
        self.assertEqual(S._verify_book_rows(rows), [])

    def test_f6_wait_start_emits_snapshot(self):
        sim, _ = make_sim(hero_owner="human", speed=200)
        self.addCleanup(sim.close)
        seen = False
        for _ in range(4000):
            sim._tick()
            if sim.status()["waiting_for"] == "hero":
                seen = True
                break
            sim.clock.real_sleep(0.002)
        self.assertTrue(seen)
        rows = rows_of(os.path.join(sim.outdir, "log.jsonl"))
        self.assertTrue(any(r["type"] == "snapshot" and r.get("waiting_for") == "hero"
                            for r in rows))

    def test_f7_pov_npc_cancels_prompt(self):
        sim, _ = make_sim(hero_owner="human", speed=200)
        self.addCleanup(sim.close)
        seen = False
        for _ in range(4000):
            sim._tick()
            if sim.status()["waiting_for"] == "hero":
                seen = True
                break
            sim.clock.real_sleep(0.002)
        self.assertTrue(seen)
        sim.set_pov("npc")
        sim.human_say("late words")
        for _ in range(200):
            sim._tick()
            sim.clock.real_sleep(0.002)
        rows = rows_of(os.path.join(sim.outdir, "log.jsonl"))
        self.assertEqual([r for r in rows
                          if r["type"] == "line" and r.get("source") == "human"], [])
        inp = [r for r in rows if r["type"] == "input"]
        self.assertEqual(inp[-1].get("ignored"), "book")


class FuseTest(unittest.TestCase):
    """Red tests for the fuse round findings F1/F4/F8-F11 (code) and F12-F14 (tests)."""
    def tearDown(self):
        S.use_scene("start")

    def test_f10_cast_name_without_alias_is_null(self):
        scene = {"id": "x", "paras": [0, 1], "cast": ["Bob B"],
                 "aliases": {"Robert": "Bob B"}, "extras": []}
        book = {"cast": {"Bob B": {"sex": "man"}}}
        text = '"Go now, quickly, please, friend," said Bob and he laughed loudly.'
        beats = B.parse_scene(text, scene, book)
        lines = [b for b in beats if b["kind"] == "line"]
        self.assertEqual(len(lines), 1)
        self.assertIsNone(lines[0]["who"])

    def test_f11_float_paras_rejected(self):
        import shutil
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        shutil.copy(os.path.join(BOOK, "ch06.txt"), d)
        with open(os.path.join(BOOK, "book.json")) as f:
            data = json.load(f)
        data["chapters"][0]["scenes"][0]["paras"] = [0, 1.5]
        with open(os.path.join(d, "book.json"), "w") as f:
            json.dump(data, f)
        with self.assertRaises(ValueError) as cm:
            B.load_book(d)
        self.assertIn("paras", str(cm.exception))

    def test_f8_no_alias_keeps_previous_speaker(self):
        scene = {"id": "x", "paras": [0, 3], "cast": ["Alice A", "Bob B"],
                 "aliases": {"Alice": "Alice A", "Bob": "Bob B"}}
        book = {"cast": {"Alice A": {"sex": "woman"}, "Bob B": {"sex": "man"}}}
        text = ('"Hello," said Bob.\n\n'
                'He waited quietly on the long road home.\n\n'
                '"Go now, quickly, please, friend."')
        beats = B.parse_scene(text, scene, book)
        lines = [b for b in beats if b["kind"] == "line"]
        self.assertEqual(lines[0]["who"], "Bob B")
        self.assertEqual(lines[1]["who"], "Bob B")

    def test_205_turn_change_through_narration_is_null(self):
        # like library 204->205: several sentences dwelling on the previous
        # speaker mean someone else speaks next, but whom is the owner's call.
        scene = {"id": "x", "paras": [0, 3], "cast": ["Alice A", "Bob B"],
                 "aliases": {"Alice": "Alice A", "Bob": "Bob B"}}
        book = {"cast": {"Alice A": {"sex": "woman"}, "Bob B": {"sex": "man"}}}
        text = ('"Hello," said Bob.\n\n'
                'He was real. He was no ghost at all. She rallied her forces calmly.\n\n'
                '"Go now, quickly, please, friend."')
        beats = B.parse_scene(text, scene, book)
        lines = [b for b in beats if b["kind"] == "line"]
        self.assertEqual(lines[0]["who"], "Bob B")
        self.assertIsNone(lines[1]["who"])

    def test_f9_human_answers_later_pov_beat(self):
        rows = [{"type": "book", "scene": "x", "beats": [
                    {"kind": "line", "who": "H", "text": "T1"},
                    {"kind": "line", "who": "A", "text": "T2"},
                    {"kind": "line", "who": "H", "text": "T3"}]},
                {"type": "line", "source": "book", "who": "H", "text": "T1"},
                {"type": "line", "source": "book", "who": "A", "text": "T2"},
                {"type": "line", "source": "human", "who": "H", "text": "answer"}]
        self.assertEqual(S._verify_book_rows(rows), [])

    def test_f4_human_first_then_book_rest(self):
        rows = [{"type": "book", "scene": "x", "beats": [
                    {"kind": "line", "who": "H", "text": "T1"},
                    {"kind": "line", "who": "A", "text": "T2"}]},
                {"type": "line", "source": "human", "who": "H", "text": "HX"},
                {"type": "line", "source": "book", "who": "A", "text": "T2"}]
        self.assertEqual(S._verify_book_rows(rows), [])


if __name__ == "__main__":
    unittest.main()
