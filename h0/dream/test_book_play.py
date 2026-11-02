"""Contract tests for book mode in sim (K2, K3): the score is played, nothing is generated.
usage: cd h0/dream && python3 -m unittest -q test_book_play
"""
import json
import os
import tempfile
import unittest

import book as B
import sim as S

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK = os.path.join(HERE, "books", "gwtw")
ZERO = ("prompt", "consult", "memory_compact", "loop_cut", "pressure", "event", "judge")
# F12: every row type the engine could emit before block K (book/book_end excluded).
# door/build/ready/memory_fail come from the fsm/director (pipe2), not the book.
PRE_K2_TYPES = frozenset({
    "snapshot", "line", "line_queued", "line_prepared", "line_discarded", "line_fail",
    "narrator", "transition", "prompt", "consult", "memory_compact", "memory_compact_fail",
    "memory_fail", "loop_cut", "pressure", "event", "judge", "goal", "image", "input", "input_dropped",
    "input_rejected", "cost", "message", "pov", "safety_pause", "schedule", "silence",
    "stop", "timeout", "tts_fail", "turn_replace", "turn_skip", "door", "build", "ready",
})


def rows_of(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def play(**kw):
    out, log = S.run(book=BOOK, fake=True, speed=1000, **kw)
    return out, log, rows_of(log)


def make_sim(scene="library", hero_owner=None, speed=1.0):
    plan = S._load_book_plan(BOOK, [scene])
    S.use_scene(plan["scenes"][0]["dict"])
    sim = S.Sim(profile=None, fake=True, speed=speed, outdir=tempfile.mkdtemp(), book=plan,
                script=[], hero_owner=hero_owner)
    return sim, plan


class PlayTest(unittest.TestCase):
    def tearDown(self):
        S.use_scene("start")  # book runs replace the module-level opening scene

    def test_library_played_exactly(self):
        score = B.score_scene(BOOK, "library")
        before = S.get_spent()  # process-wide counter: other tests may have spent already
        out, log, rows = play(scenes=["library"])
        self.assertEqual(S.get_spent(), before)
        book = [r for r in rows if r["type"] == "book"]
        self.assertEqual(len(book), 1)
        self.assertEqual(book[0]["scene"], "library")
        self.assertEqual(len(book[0]["beats"]), len(score["beats"]))
        lines = [r for r in rows if r["type"] == "line"]
        want = [b for b in score["beats"] if b["kind"] == "line" and b["who"]]
        self.assertEqual([(r["who"], r["text"]) for r in lines], [(b["who"], b["text"]) for b in want])
        self.assertTrue(all(r["source"] == "book" for r in lines))
        narr = [r for r in rows if r["type"] == "narrator"]
        self.assertEqual(len(narr), len(score["beats"]) - len(want))
        for t in ZERO:
            self.assertEqual([r for r in rows if r["type"] == t], [], t)
        self.assertEqual([r for r in rows if r["type"] == "cost"][-1]["dollars"], before)
        self.assertFalse([r for r in rows if "npc line" in str(r.get("text", ""))])
        self.assertTrue(any(r["type"] == "book_end" and r["scene"] == "library" for r in rows))
        rep = S.verify_run(out, log, 20.0, actual_spent=before)
        self.assertTrue(rep["ok"], rep["issues"])

    def test_verify_catches_missing_line(self):
        out, log, rows = play(scenes=["library"])
        i = next(i for i, r in enumerate(rows) if r["type"] == "line")
        del rows[i]
        bad = os.path.join(out, "bad.jsonl")
        with open(bad, "w") as f:
            f.write("\n".join(json.dumps(r) for r in rows))
        self.assertFalse(S.verify_run(out, bad, 20.0)["ok"])

    def test_score_override_and_mismatch(self):
        score = B.score_scene(BOOK, "library")
        for b in score["beats"]:
            if b["para"] == 203 and b["kind"] == "line":
                b["who"] = "Ashley Wilkes"
        path = os.path.join(tempfile.mkdtemp(), "s.json")
        with open(path, "w") as f:
            json.dump(score, f)
        _, _, rows = play(scenes=["library"], score=path)
        spoken = [r for r in rows if r["type"] == "line" and r["text"].startswith("It is bad enough")]
        self.assertEqual(spoken[0]["who"], "Ashley Wilkes")
        with self.assertRaises(SystemExit) as cm:
            S.main(["--book", BOOK, "--score", path, "--scene", "lawn", "--fake", "--speed", "1000"])
        self.assertEqual(cm.exception.code, 2)

    def test_two_scenes_one_transition(self):
        _, _, rows = play(scenes=["lawn", "library"])
        tr = [r for r in rows if r["type"] == "transition"]
        self.assertEqual(len(tr), 1)
        self.assertEqual(tr[0]["cause"], "book")
        snaps = [r for r in rows if r["type"] == "snapshot" and r["t"] >= tr[0]["t"]]
        self.assertIn("Ashley Wilkes", snaps[0]["actors"])
        self.assertIn("library", snaps[0]["place"].lower())
        end = [r for r in rows if r["type"] == "book_end"]
        self.assertEqual(end[0]["scene"], "library")
        self.assertEqual([r["scene"] for r in rows if r["type"] == "book"], ["lawn", "library"])

    def test_human_say_ignored(self):
        sim, _ = make_sim(speed=50)
        self.addCleanup(sim.close)
        for _ in range(5):
            sim._tick()
        sim.human_say("hello")
        for _ in range(50):
            sim._tick()
            sim.clock.real_sleep(0.01)
        rows = rows_of(os.path.join(sim.outdir, "log.jsonl"))
        inp = [r for r in rows if r["type"] == "input"]
        self.assertEqual(len(inp), 1)
        self.assertEqual(inp[0]["ignored"], "book")
        self.assertFalse([r for r in rows if r["type"] in ("consult", "line_queued")])

    def test_plain_run_unchanged(self):
        out, log = S.run(profile="A", fake=True, max_transitions=1, speed=50, max_seconds=3)
        rows = rows_of(log)
        types = {r["type"] for r in rows}
        self.assertTrue(any(r["type"] == "line" and r["text"] == "npc line 1" for r in rows))
        self.assertFalse(types & {"book", "book_end"})
        self.assertFalse([r for r in rows if r["type"] == "narrator" and r.get("cause") == "book"])
        self.assertFalse([r for r in rows if r["type"] == "line" and r.get("source") == "book"])
        # F12: no new row types outside the pre-K2 set.
        self.assertLessEqual(types, PRE_K2_TYPES, types - PRE_K2_TYPES)


class PrompterTest(unittest.TestCase):
    def tearDown(self):
        S.use_scene("start")

    def _run_to_pov(self, sim):
        for _ in range(4000):
            sim._tick()
            if sim.status()["waiting_for"] == "hero":
                return True
            sim.clock.real_sleep(0.002)
        return False

    def test_human_answers_in_window(self):
        sim, plan = make_sim(hero_owner="human", speed=200)
        self.addCleanup(sim.close)
        self.assertTrue(self._run_to_pov(sim))
        st = sim.status()
        self.assertEqual(st["waiting_for"], "hero")
        want = sim.book["beats"][sim.book["cursor"]]
        self.assertEqual(st["prompt_text"], want["text"])
        sim.human_say("my own words")
        nxt = sim.book["beats"][sim.book["cursor"]]
        for _ in range(4000):
            sim._tick()
            sim.clock.real_sleep(0.002)
            rows = rows_of(os.path.join(sim.outdir, "log.jsonl"))
            if any(r["type"] == "line" and r.get("source") == "book" and r["text"] == nxt.get("text")
                   for r in rows) or any(r["type"] == "narrator" and nxt["text"] in r["text"] for r in rows):
                break
        mine = [r for r in rows if r["type"] == "line" and r.get("source") == "human"]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["who"], sim.hero)
        self.assertEqual(mine[0]["text"], "my own words")
        self.assertNotIn(want["text"], [r["text"] for r in rows if r["type"] == "line"])

    def test_silence_plays_the_book(self):
        sim, plan = make_sim(hero_owner="human", speed=200)
        self.addCleanup(sim.close)
        self.assertTrue(self._run_to_pov(sim))
        want = sim.book["beats"][sim.book["cursor"]]["text"]
        for _ in range(4000):
            sim._tick()
            sim.clock.real_sleep(0.002)
            rows = rows_of(os.path.join(sim.outdir, "log.jsonl"))
            if any(r["type"] == "line" and r["text"] == want for r in rows):
                break
        hit = [r for r in rows if r["type"] == "line" and r["text"] == want]
        self.assertEqual(hit[0]["source"], "book")

    def test_book_line_joins_transcript(self):
        sim, _ = make_sim()
        self.assertIsNone(sim.dialogue)
        who = sim.actors[0] if sim.actors else sim.hero
        sim.npc_start({"who": who, "actor": who, "role": "actor",
                       "text": "Fiddle-dee-dee.", "source": "book"})
        self.assertEqual(sim.transcript, [(who, "Fiddle-dee-dee.")])

    def test_without_human_same_sequence(self):
        _, _, rows = play(scenes=["library"])
        self.assertEqual([r for r in rows if r["type"] == "pov"], [])
        self.assertTrue(all(r.get("waiting_for") is None for r in rows if r["type"] == "snapshot"))
        # F13: without --hero human the played (type, who, text) sequence is the K2 baseline.
        score = B.score_scene(BOOK, "library")
        want = []
        for b in score["beats"]:
            if b["kind"] == "line" and b["who"]:
                want.append(("line", b["who"], b["text"]))
            elif b["kind"] == "narration":
                want.append(("narrator", None, b["text"]))
            else:
                want.append(("narrator", None, '"%s"' % b["text"]))
        got = [(r["type"], r.get("who"), r["text"])
               for r in rows if r["type"] in ("line", "narrator")]
        self.assertEqual(got, want)


if __name__ == "__main__":
    unittest.main()


class _OkVoice:
    def synthesize(self, text, label, path):
        with open(path, "wb") as f:
            f.write(b"RIFF")
        return {"ok": True, "audio": path, "seconds": 1.0}


class BeatIndexTest(unittest.TestCase):
    """Г8: book events carry `beat`, the index of their beat in score.beats."""

    def tearDown(self):
        S.use_scene("start")

    def test_book_lines_and_narration_carry_beat_in_order(self):
        score = B.score_scene(BOOK, "library")
        _, _, rows = play(scenes=["library"])
        got = [r.get("beat") for r in rows
               if (r["type"] == "line" and r.get("source") == "book")
               or (r["type"] == "narrator" and r.get("cause") == "book")]
        self.assertEqual(got, list(range(len(score["beats"]))))

    def test_voiced_narration_carries_beat(self):
        sim, _ = make_sim()
        self.addCleanup(sim.close)
        sim._voice = _OkVoice()
        sim._book_narrate("Words of the book.", "old_man", beat=4)
        self.assertTrue(sim._book_voicing["done"].wait(5))
        sim._book_narrated()
        rows = rows_of(os.path.join(sim.outdir, "log.jsonl"))
        narr = [r for r in rows if r["type"] == "narrator" and r.get("cause") == "book"]
        self.assertEqual(narr[-1]["beat"], 4)
        self.assertIn("audio", narr[-1])

    def test_human_answer_carries_its_beat(self):
        sim, _ = make_sim(hero_owner="human", speed=200)
        self.addCleanup(sim.close)
        for _ in range(4000):
            sim._tick()
            if sim.status()["waiting_for"] == "hero":
                break
            sim.clock.real_sleep(0.002)
        self.assertEqual(sim.status()["waiting_for"], "hero")
        cursor = sim.book["cursor"]
        sim.human_say("my own words")
        rows = rows_of(os.path.join(sim.outdir, "log.jsonl"))
        mine = [r for r in rows if r["type"] == "line" and r.get("source") == "human"]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["beat"], cursor)
