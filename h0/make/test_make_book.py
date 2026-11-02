"""Н15 red: python3 -m make.book — book text -> film, offline (--fake only)."""
import json
import shutil
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

import llm_http

from . import book as mb
from dream.book import load_book

TEXT = ("Mira woke early and looked at the window.\n\n"
        "Her grandfather said the lamb was late for the meadow.\n\n"
        "They walked out into the yard together.\n")


def _no_net(*a, **k):
    raise AssertionError("network is forbidden in tests")


class Base(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", _no_net)
        p.start()
        self.addCleanup(p.stop)
        self.tmp = Path(tempfile.mkdtemp())
        self.txt = self.tmp / "story.txt"
        self.txt.write_text(TEXT, encoding="utf-8")
        self.cast = self.tmp / "cast"
        self.cast.mkdir()
        fix = Path(__file__).resolve().parent / "testdata" / "cast"
        for f in fix.iterdir():
            if f.is_file():
                shutil.copy(f, self.cast / f.name)
        self.out = self.tmp / "film.mp4"

    def run_chain(self, **kw):
        kw.setdefault("cast_dir", self.cast)
        return mb.run_book(self.txt, self.out, fake=True, **kw)


class TestSparkAndBudget(Base):
    def test_spark_goes_through_llm_http_post(self):
        calls = []

        def fake_post(url, auth, payload, timeout, retries):
            calls.append(payload)
            return {"content": "{}", "usage": {}, "raw": {}}

        with mock.patch.object(llm_http, "post", fake_post):
            mb.spark_call("sys", "user", key="k")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["model"], "muse-spark-1.3-contributor")

    def test_paid_model_refused(self):
        paid = "muse-spark-1" + ".3"
        with mock.patch.object(llm_http, "post", side_effect=AssertionError("must not call")):
            with self.assertRaises(ValueError):
                mb.spark_call("s", "u", model=paid, key="k")
        with self.assertRaises(llm_http.TransportError):  # the real client refuses too
            llm_http.post("https://api.meta.ai/v1/chat/completions", "k",
                          {"model": paid}, 1, 0)

    def test_ceiling_stops_before_the_call(self):
        res = self.run_chain(max_dollars=2.5)
        self.assertEqual(res["failed"], "world")
        self.assertIn("budget", res["reason"])
        self.assertEqual(res["status"]["read"], "ran")
        self.assertNotIn("world", [s for s, v in res["status"].items() if v == "ran"])
        self.assertLessEqual(res["usd"], 2.5)


class TestContracts(Base):
    def test_tampered_world_fails_at_cast(self):
        def bad_world(ctx):
            (ctx.out / "junk.txt").write_text("x")
            return 0.0

        res = self.run_chain(steps={"world": bad_world})
        self.assertEqual(res["failed"], "cast")
        self.assertIn("places.json", res["reason"])

    def test_tampered_read_fails_at_voices(self):
        def bad_read(ctx):
            (ctx.out / "book.json").write_text(json.dumps({"cast": {}}))
            return 0.0

        res = self.run_chain(steps={"read": bad_read})
        self.assertEqual(res["failed"], "voices")

    def test_tampered_score_fails_at_stage(self):
        def bad_story(ctx):
            (ctx.out / "score.json").write_text("not json")
            return 0.0

        res = self.run_chain(steps={"story": bad_story})
        self.assertEqual(res["failed"], "stage")

    def test_tampered_stage_fails_at_film(self):
        def bad_stage(ctx):
            (ctx.out / "events.json").write_text("not json")
            return 0.0

        res = self.run_chain(steps={"stage": bad_stage})
        self.assertEqual(res["failed"], "film")
        self.assertIn("events.json", res["reason"])

    def test_tampered_cast_fails_at_story(self):
        def bad_cast(ctx):
            (ctx.out / "cast.json").write_text("[]")
            return 0.0

        res = self.run_chain(steps={"cast": bad_cast})
        self.assertEqual(res["failed"], "story")
        self.assertIn("cast", res["reason"])

    def test_cached_film_restores_out(self):
        res = self.run_chain()
        self.assertIsNone(res["failed"], res["reason"])
        self.assertTrue(self.out.is_file())
        self.out.unlink()
        again = self.run_chain()
        self.assertEqual(set(again["status"].values()), {"cached"})
        self.assertTrue(self.out.is_file())

    def test_cast_missing_stops_before_world(self):
        res = mb.run_book(self.txt, self.out, fake=True, cast_dir=self.tmp / "nope")
        self.assertEqual(res["failed"], "world")
        self.assertIn("CAST_MISSING", res["reason"])
        self.assertNotIn("world", res["status"])

    def test_cached_corruption_fails_next_step(self):
        res = self.run_chain()
        self.assertIsNone(res["failed"], res["reason"])
        run = mb.run_dir_for(self.out)
        (run / "read" / "book.json").write_text("{broken", encoding="utf-8")
        again = self.run_chain()
        self.assertEqual(again["failed"], "voices")
        self.assertIn("book.json", again["reason"])


class TestChain(Base):
    STEPS = ["read", "voices", "world", "cast", "story", "stage", "film"]

    def test_full_chain_cache_and_edit(self):
        res = self.run_chain()
        self.assertIsNone(res["failed"], res["reason"])
        self.assertEqual([s for s in self.STEPS if res["status"][s] == "ran"], self.STEPS)
        run = mb.run_dir_for(self.out)
        book = load_book(str(run / "read"))
        self.assertTrue(all(c["voice"] for c in book["cast"].values()))
        self.assertTrue(self.out.is_file())
        again = self.run_chain()
        self.assertEqual(set(again["status"].values()), {"cached"})
        self.txt.write_text(TEXT + "\nThe end came quietly.\n", encoding="utf-8")
        third = self.run_chain()
        self.assertEqual(third["status"]["read"], "ran")
        self.assertEqual(third["status"]["film"], "ran")

    def test_lang_recomputes_story_and_stage_only(self):
        self.run_chain()
        res = self.run_chain(lang="ru")
        self.assertEqual(res["status"]["world"], "cached")
        self.assertEqual(res["status"]["story"], "ran")
        self.assertEqual(res["status"]["stage"], "ran")

    def test_refs_with_and_without(self):
        self.run_chain()
        run = mb.run_dir_for(self.out)
        self.assertEqual((run / "world" / "cues.md").read_text(), "")
        refs = self.tmp / "refs" / "home"
        refs.mkdir(parents=True)
        (refs / "1.png").write_bytes(b"png")
        self.run_chain()
        self.assertTrue((run / "world" / "refs" / "home" / "1.png").is_file())
        self.assertNotEqual((run / "world" / "cues.md").read_text(), "")

    def test_voice_rule(self):
        voices = {k: "id" for k in ("child", "woman", "man", "old_woman", "old_man")}
        pick = lambda s, a: mb.pick_voice(s, a, voices)[0]
        self.assertEqual(pick("woman", 9), "child")
        self.assertEqual(pick("man", 13), "child")
        self.assertEqual(pick("woman", 14), "woman")
        self.assertEqual(pick("man", 60), "man")
        self.assertEqual(pick("man", 61), "old_man")
        self.assertEqual(pick("woman", 80), "old_woman")
        v, warn = mb.pick_voice("woman", 80, {"woman": "w", "man": "m"})
        self.assertEqual((v, warn), ("woman", None))
        v, warn = mb.pick_voice("other", 30, {"x": "1"})
        self.assertEqual(v, "x")
        self.assertTrue(warn)


class TestBookContractsRed(Base):
    def test_world_produces_dist(self):
        res = self.run_chain()
        self.assertIsNone(res["failed"], res["reason"])
        run = mb.run_dir_for(self.out)
        self.assertTrue((run / "world" / "run" / "dist" / "geometry.json").is_file())

    def test_cast_copies_glb(self):
        from pathlib import Path as _P
        fixture = _P(mb.__file__).parent / "testdata" / "cast"
        self.assertTrue((fixture / "jane.glb").is_file())
        res = mb.run_book(self.txt, self.out, fake=True, cast_dir=fixture)
        self.assertIsNone(res["failed"], res["reason"])
        run = mb.run_dir_for(self.out)
        glbs = list((run / "cast").glob("*.glb"))
        self.assertTrue(glbs, "cast step must copy GLB files")

    def test_stage_writes_stage_json(self):
        res = self.run_chain()
        self.assertIsNone(res["failed"], res["reason"])
        run = mb.run_dir_for(self.out)
        self.assertTrue((run / "stage" / "stage.json").is_file())

    def test_read_rejects_missing_look(self):
        bad = {"pov": "M", "narrator_voice": "man",
               "cast": {"M": {"sex": "female", "age": 20}},
               "places": {"p": {"desc": "x", "exits": []}},
               "chapters": [{"n": 1, "file": "book.txt", "title": "t",
                             "scenes": [{"id": "a", "paras": [0, 1],
                                         "place": "p", "cast": ["M"]}]}]}
        ctx = mb.Ctx(self.tmp, self.tmp, TEXT, self.txt, "en", False, None)
        with mock.patch.object(mb, "_read_live", return_value=bad):
            with self.assertRaises(mb.StepError):
                mb._step_read(ctx)

    def test_lang_requires_score_lang(self):
        def only_en(ctx):
            (ctx.out / "score.json").write_text(json.dumps({"beats": []}))
            return 0.0
        res = self.run_chain(lang="ru", steps={"story": only_en})
        self.assertEqual(res["failed"], "stage")

    def test_runbook_translation_uses_llm_post(self):
        calls = []
        translated = ["Переведённый абзац %d" % i
                      for i, _ in enumerate(mb._paras(self.txt.read_text(encoding="utf-8")), 1)]

        def fake_post(url, auth, payload, timeout, retries):
            calls.append(payload)
            return {"content": json.dumps({"texts": translated}, ensure_ascii=False),
                    "usage": {}, "raw": {}}
        real_read = mb._read_live
        book = {"pov": "Hero", "narrator_voice": "man",
                "cast": {"Hero": {"sex": "woman", "age": 9, "look": "x"}},
                "places": {"home": {"desc": "x", "exits": []}},
                "chapters": [{"n": 1, "file": "book.txt", "title": "t",
                              "scenes": [{"id": "s1", "paras": [0, 1],
                                          "place": "home", "cast": ["Hero"]}]}]}
        with mock.patch.object(mb, "_read_live", return_value=book):
            with mock.patch.object(llm_http, "post", fake_post):
                res = mb.run_book(self.txt, self.out, fake=False, lang="ru",
                                  live=True, cast_dir=self.cast)
        self.assertIsNone(res["failed"], res["reason"])
        self.assertTrue(calls, "story translation must go through llm_http.post")
        run = mb.run_dir_for(self.out)
        score = json.loads((run / "story" / "score.ru.json").read_text(encoding="utf-8"))
        self.assertEqual([beat["text"] for beat in score["beats"]], translated)


class TestBookReviewRed(Base):
    def _book(self, *, chapters=None, places=None, scene_place="p"):
        return {"pov": "M", "narrator_voice": "man",
                "cast": {"M": {"sex": "woman", "age": 20, "look": "x"}},
                "places": places if places is not None else {"p": {"desc": "x", "exits": []}},
                "chapters": chapters if chapters is not None else [
                    {"n": 1, "file": "book.txt", "title": "t",
                     "scenes": [{"id": "s", "paras": [0, 1], "place": scene_place, "cast": ["M"]}]}]}

    def _read_ctx(self, out=None):
        out = out or self.tmp
        out.mkdir(parents=True, exist_ok=True)
        return mb.Ctx(self.tmp, out, TEXT, self.txt, "en", False, None)

    def _assert_f34_read_and_check_reject(self, book, label):
        out = self.tmp / ("read-" + label)
        out.mkdir()
        read_rejected = False
        with mock.patch.object(mb, "_read_live", return_value=book):
            try:
                mb._step_read(self._read_ctx(out))
            except mb.StepError:
                read_rejected = True
        check_dir = self.tmp / ("check-" + label)
        check_dir.mkdir()
        (check_dir / "book.json").write_text(json.dumps(book), encoding="utf-8")
        check_rejected = False
        try:
            mb._check_book(check_dir, "review")
        except mb.StepError:
            check_rejected = True
        self.assertEqual((read_rejected, check_rejected), (True, True))

    def test_f34_read_rejects_empty_chapters(self):
        self._assert_f34_read_and_check_reject(self._book(chapters=[]), "empty-chapters")

    def test_f34_read_rejects_book_without_places(self):
        self._assert_f34_read_and_check_reject(self._book(places={}), "no-places")

    def test_f34_read_rejects_unknown_scene_place(self):
        self._assert_f34_read_and_check_reject(self._book(scene_place="missing"), "unknown-place")

    def _live_book(self):
        return self._book()

    def test_f35_live_translation_error_fails_story_without_fake_fallback(self):
        with mock.patch.object(mb, "_read_live", return_value=self._live_book()), \
             mock.patch.object(llm_http, "post", side_effect=RuntimeError("translation unavailable")):
            result = mb.run_book(self.txt, self.out, fake=False, lang="ru", live=True, cast_dir=self.cast)
        self.assertEqual(result["failed"], "story")

    def test_f35_short_live_translation_fails_story(self):
        def short_translation(url, auth, payload, timeout, retries):
            return {"content": '{"texts": []}', "usage": {}, "raw": {}}

        with mock.patch.object(mb, "_read_live", return_value=self._live_book()), \
             mock.patch.object(llm_http, "post", short_translation):
            result = mb.run_book(self.txt, self.out, fake=False, lang="ru", live=True, cast_dir=self.cast)
        self.assertEqual(result["failed"], "story")

    def test_f38_read_rejects_file_paths_outside_output_dir(self):
        cases = (self.tmp / "absolute.txt", "../traversal.txt")
        for file_name in cases:
            with self.subTest(file=file_name):
                out = self.tmp / ("out-abs" if isinstance(file_name, Path) else "out-parent")
                out.mkdir(exist_ok=True)
                outside = file_name if isinstance(file_name, Path) else out.parent / "traversal.txt"
                book = self._book(chapters=[{"n": 1, "file": str(file_name), "title": "t",
                                             "scenes": [{"id": "s", "paras": [0, 1], "place": "p", "cast": ["M"]}]}])
                try:
                    raised = False
                    with mock.patch.object(mb, "_read_live", return_value=book):
                        try:
                            mb._step_read(self._read_ctx(out))
                        except mb.StepError:
                            raised = True
                    self.assertEqual((raised, outside.exists()),
                                     (True, False), "read step must reject paths outside ctx.out without writing them")
                finally:
                    outside.unlink(missing_ok=True)

    def test_f39_spark_uses_meta_model_api_key_as_bearer(self):
        calls = []

        def fake_post(url, auth, payload, timeout, retries):
            calls.append(auth)
            return {"content": "{}", "usage": {}, "raw": {}}

        with mock.patch.dict(mb.os.environ, {"META_MODEL_API_KEY": "test-only-key"}, clear=True), \
             mock.patch.object(llm_http, "post", fake_post):
            mb.spark_call("sys", "user")
        self.assertEqual(calls, ["Bearer test-only-key"])


if __name__ == "__main__":
    unittest.main()
