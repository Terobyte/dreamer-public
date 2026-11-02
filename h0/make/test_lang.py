"""--lang ru: Spark translates the score once per scene (cached by sha256), stage hash sees the language."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import core, film, story

JANE = Path(__file__).resolve().parents[1] / "dream" / "books" / "jane-eyre"
ENGINE = Path(__file__).resolve().parents[2] / "engine"


class Lang(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network"))
        p.start()
        self.addCleanup(p.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.book = Path(self.tmp.name) / "book"
        shutil.copytree(JANE, self.book)
        self.run_dir = Path(self.tmp.name) / "run"

    def make(self, **kw):
        return core.run_make(self.run_dir, "p", fake=True, book=str(self.book), scene="tea", **kw)

    def test_ru_translates_score_once_and_caches(self):
        calls = []

        def fake_ru(texts, lang):
            calls.append(list(texts))
            return ["Привет: " + t for t in texts]
        with mock.patch.object(story, "fake_translate", fake_ru):
            res = self.make(until="stage", lang="ru")
            self.assertEqual(res["stage"], "ran", res)
            self.assertEqual(len(calls), 1)
            sd = self.run_dir / "story"
            orig = json.loads((sd / "score.json").read_text())
            ru = json.loads((sd / "score.ru.json").read_text())
            self.assertTrue(any(b["text"].startswith("Привет: ") for b in ru["beats"]))
            self.assertFalse(any(b.get("text", "").startswith("Привет") for b in orig["beats"]))
            sj = json.loads((self.run_dir / "stage" / "stage.json").read_text())
            self.assertEqual(sj["book"]["score"], "story/score.ru.json")
            sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dream"))
            import sim
            plan = sim._load_book_plan(str(self.book), ["tea"], ru)
            self.assertTrue(any(b.get("text", "").startswith("Привет: ") for b in plan["scenes"][0]["beats"]))
            # second run: same everything, no Spark
            self.make(until="stage", lang="ru")
            self.assertEqual(len(calls), 1)
            # story rebuilt (fresh) -> the sha256 cache in story/ still answers
            self.make(from_="story", lang="ru")
            self.assertEqual(len(calls), 1)

    def test_lang_changes_stage_hash(self):
        with mock.patch.object(story, "fake_translate", lambda t, l: list(t)):
            self.make(until="stage")
            res = self.make(only="stage", lang="ru")
            self.assertEqual(res["stage"], "ran", res)
            sj = json.loads((self.run_dir / "stage" / "stage.json").read_text())
            self.assertEqual(sj["lang"], "ru")

    def test_default_en_has_no_lang_trace(self):
        self.make(until="stage")
        sj = json.loads((self.run_dir / "stage" / "stage.json").read_text())
        self.assertNotIn("lang", sj)
        self.assertEqual(sj["book"]["score"], "story/score.json")
        self.assertFalse((self.run_dir / "story" / "score.ru.json").exists())

    def test_ru_voice_key_and_fallback_warning(self):
        from make import stage
        pool = {"woman": "w-id", "man": "m-id", "woman@ru": "w-ru"}
        self.assertEqual(stage._pick_voice(pool, "woman", "ru"), ("w-ru", None))
        rid, warn = stage._pick_voice(pool, "man", "ru")
        self.assertEqual(rid, "m-id")
        self.assertIn("man@ru", warn)
        self.assertEqual(stage._pick_voice(pool, "woman", "en"), ("w-id", None))

    def test_film_has_lang_flag(self):
        with mock.patch.object(film, "film") as f:
            film.main(["r1", "--out", "x.mp4", "--lang", "ru"])
            self.assertEqual(f.call_args.kwargs.get("lang"), "ru")

    # --- F1: en play after ru run must give English, not Russian ---
    def test_en_after_ru_gives_en(self):
        def fake_ru(texts, lang):
            return [f"[ru] {t}" for t in texts]
        with mock.patch.object(story, "fake_translate", fake_ru):
            self.make(until="stage", lang="ru")
        from make import play as mplay
        from make.testdata import synth_world  # noqa: F401
        _, log = mplay.play(self.run_dir, fake=True, lang="en")
        rows = [json.loads(l) for l in Path(log).read_text().splitlines() if l.strip()]
        line_texts = [r["text"] for r in rows if r["type"] in ("line", "narrator")]
        self.assertTrue(line_texts, "no line/narrator events")
        self.assertFalse(any(t.startswith("[ru]") for t in line_texts),
                         f"en play gave ru text: {line_texts[:3]}")
        _, log_ru = mplay.play(self.run_dir, fake=True, lang="ru")
        rows_ru = [json.loads(l) for l in Path(log_ru).read_text().splitlines() if l.strip()]
        line_ru = [r["text"] for r in rows_ru if r["type"] in ("line", "narrator")]
        self.assertTrue(any(t.startswith("[ru]") for t in line_ru))

    # --- F2: book.json cast voices must be in stage voices ---
    def test_book_cast_voice_in_stage_ru(self):
        bj = json.loads((self.book / "book.json").read_text())
        bj["cast"]["A"] = {"sex": "female", "voice": "child", "look": "small"}
        for ch in bj["chapters"]:
            for sc in ch["scenes"]:
                if sc["id"] == "tea":
                    if "A" not in sc["cast"]:
                        sc["cast"].append("A")
        (self.book / "book.json").write_text(json.dumps(bj, ensure_ascii=False, indent=2))
        voices_path = Path(__file__).resolve().parents[1] / "dream" / "voices.json"
        orig_voices = json.loads(voices_path.read_text())
        patched = dict(orig_voices)
        patched["child@ru"] = "ru-child-id"
        from make import stage as mstage
        orig_load = mstage._load
        def fake_load(p):
            if Path(p).name == "voices.json":
                return patched
            return orig_load(p)
        with mock.patch.object(mstage, "_load", side_effect=fake_load):
            with mock.patch.object(story, "fake_translate", lambda t, l: list(t)):
                res = self.make(until="stage", lang="ru")
                self.assertEqual(res["stage"], "ran", res)
                sj = json.loads((self.run_dir / "stage" / "stage.json").read_text())
                self.assertIn("child", sj["voices"])
                self.assertEqual(sj["voices"]["child"], "ru-child-id")
        patched2 = dict(orig_voices)
        patched2.pop("child@ru", None)
        def fake_load2(p):
            if Path(p).name == "voices.json":
                return patched2
            return orig_load(p)
        with mock.patch.object(mstage, "_load", side_effect=fake_load2):
            with mock.patch.object(story, "fake_translate", lambda t, l: list(t)):
                run2 = Path(self.tmp.name) / "run2"
                core.run_make(run2, "p", fake=True, book=str(self.book), scene="tea", lang="ru")
                sj2 = json.loads((run2 / "stage" / "stage.json").read_text())
                self.assertIn("child", sj2["voices"])
                self.assertEqual(sj2["voices"]["child"], orig_voices["child"])

    # --- F5: en mode must not leak book-only voices (contract: без --lang побайтно как раньше) ---
    def test_en_does_not_leak_book_voices(self):
        bj = json.loads((self.book / "book.json").read_text())
        bj["cast"]["A"] = {"sex": "female", "voice": "child", "look": "small"}
        for ch in bj["chapters"]:
            for sc in ch["scenes"]:
                if sc["id"] == "tea":
                    if "A" not in sc["cast"]:
                        sc["cast"].append("A")
        (self.book / "book.json").write_text(json.dumps(bj, ensure_ascii=False, indent=2))
        res = self.make(until="stage")
        self.assertEqual(res["stage"], "ran", res)
        sj = json.loads((self.run_dir / "stage" / "stage.json").read_text())
        self.assertNotIn("child", sj["voices"], f"en mode leaked book voice child: {sj['voices']}")
        self.assertNotIn("old_woman", sj["voices"], f"en mode leaked book voice old_woman: {sj['voices']}")
        self.assertNotIn("lang", sj)

    # --- F3: Spark adapter + subtitles / events + caching ---
    def test_ru_events_and_subtitles_and_spark_cache(self):
        calls = []
        def fake_ru(texts, lang):
            calls.append(list(texts))
            return [f"[ru] {t}" for t in texts]
        with mock.patch.object(story, "fake_translate", fake_ru):
            self.make(until="stage", lang="ru")
            self.assertEqual(len(calls), 1)
            from make import play as mplay
            _, log = mplay.play(self.run_dir, fake=True, lang="ru")
            rows = [json.loads(l) for l in Path(log).read_text().splitlines() if l.strip()]
            texts = [r["text"] for r in rows if r["type"] in ("line", "narrator")]
            self.assertTrue(texts)
            self.assertTrue(any(t.startswith("[ru]") for t in texts), texts[:3])
            self.make(until="stage", lang="ru")
            self.assertEqual(len(calls), 1)

    def test_spark_translate_adapter_via_fake_transport(self):
        # Verify _spark_translate path is exercised: mock transport.post, not Spark
        tmp = Path(self.tmp.name) / "ctx_test"
        run_dir = tmp / "run"
        out = tmp / "out"
        run_dir.mkdir(parents=True)
        out.mkdir(parents=True)
        (run_dir / "story").mkdir(parents=True)
        score = {"book": "x", "scene": "tea", "place": "p", "cast": [], "beats": [
            {"kind": "line", "who": "A", "text": "Hello world", "para": 0},
            {"kind": "narration", "who": None, "text": "It was dark.", "para": 1},
            {"kind": "world", "text": "door opens", "para": 2},
        ]}
        transport_calls = []

        class DummyTransport:
            def post(self, body, timeout):
                transport_calls.append(1)
                msgs = body.get("messages") or []
                orig = json.loads(msgs[1]["content"]) if len(msgs) > 1 else []
                translated = [f"[ru] {t}" for t in orig]
                content = json.dumps({"texts": translated}, ensure_ascii=False)
                text = f"```json\n{content}\n```"
                return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 10}}

        with mock.patch("make.core._spark_transport", return_value=DummyTransport()):
            ctx = core.Ctx(run_dir, out, {"fake": False}, False, None, {"lang": "ru"})
            res = story.translate_score(ctx, score, "ru")
            self.assertEqual(len(transport_calls), 1)
            self.assertTrue(any(b["text"].startswith("[ru]") for b in res["beats"] if b["kind"] in ("line", "narration")))
            tr_files = list(out.glob("tr-*.json"))
            self.assertEqual(len(tr_files), 1)
            out2 = tmp / "out2"
            out2.mkdir()
            ctx2 = core.Ctx(run_dir, out2, {"fake": False}, False, None, {"lang": "ru"})
            for f in out.glob("tr-*.json"):
                shutil.copy(f, run_dir / "story" / f.name)
            with mock.patch("make.core._spark_transport", return_value=DummyTransport()):
                res2 = story.translate_score(ctx2, score, "ru")
                # second call must hit cache (DummyTransport of ctx2 would have been called if not cached)
                # we check that no new transport call happened on ctx2
                self.assertEqual(len(transport_calls), 1, "second call should be cached via story/tr-*.json")
                self.assertEqual(res, res2)

    # --- F3+F6+F7+F8: full Spark path run_make -> play, events/subs in Russian, cache prevents second call, subs via createSubs ---
    def test_ru_spark_via_run_make_and_play_events_subs_cache(self):
        # 1) build world/cast/story/stage in fake en (so world/cast are cached stubs)
        self.make(until="stage")
        transport_calls = {"translation": 0, "director": 0}

        class DummyTransport:
            def post(self, body, timeout):
                msgs = body.get("messages") or []
                user_msg = next((m for m in msgs if m.get("role") == "user"), None)
                if user_msg is None:
                    raise AssertionError(f"Spark request has no user message: {msgs!r}")
                request = json.loads(user_msg["content"])
                if isinstance(request, list) and all(isinstance(t, str) for t in request):
                    transport_calls["translation"] += 1
                    translated = [f"[ru] {t}" for t in request]
                    content = json.dumps({"texts": translated}, ensure_ascii=False)
                elif isinstance(request, dict) and "instruction" in request:
                    transport_calls["director"] += 1
                    content = json.dumps({"start": [], "stage": []}, ensure_ascii=False)
                else:
                    raise AssertionError(f"Unexpected Spark user message: {request!r}")
                text = f"```json\n{content}\n```"
                return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 10}}

        # do NOT mock pipe2.spark.Spark – only transport, per F7
        with mock.patch("make.core._spark_transport", return_value=DummyTransport()):
            res = core.run_make(self.run_dir, "p", fake=False, live=True,
                                book=str(self.book), scene="tea", from_="story", lang="ru")
            self.assertEqual(res["story"], "ran", res)
            self.assertEqual(res["stage"], "ran", res)
            self.assertEqual(transport_calls["translation"], 1)
            self.assertEqual(transport_calls["director"], 1)
            ru = json.loads((self.run_dir / "story" / "score.ru.json").read_text())
            self.assertTrue(any(b.get("text", "").startswith("[ru]") for b in ru["beats"] if b.get("kind") in ("line", "narration")),
                            ru["beats"][:2])
            orig = json.loads((self.run_dir / "story" / "score.json").read_text())
            self.assertFalse(any(b.get("text", "").startswith("[ru]") for b in orig["beats"] if b.get("kind") in ("line", "narration")))
            sj = json.loads((self.run_dir / "stage" / "stage.json").read_text())
            self.assertEqual(sj["lang"], "ru")
            self.assertEqual(sj["book"]["score"], "story/score.ru.json")
            # play with lang=ru -> line/narrator events (subtitles) are Russian
            from make import play as mplay
            _, log = mplay.play(self.run_dir, fake=True, lang="ru")
            rows = [json.loads(l) for l in Path(log).read_text().splitlines() if l.strip()]
            texts = [r["text"] for r in rows if r["type"] in ("line", "narrator")]
            self.assertTrue(texts, "no line/narrator events from play")
            self.assertTrue(any(t.startswith("[ru]") for t in texts), texts[:3])

            # F8: verify actual subtitles via engine's createSubs, not just log filter
            subs_texts = self._subs_via_createSubs(rows)
            self.assertTrue(subs_texts, "createSubs produced no subtitles")
            self.assertTrue(any(t.startswith("[ru]") or "[ru]" in t for t in subs_texts),
                            f"createSubs subs not Russian: {subs_texts[:3]}")

            # 3) second run with same sha must reuse tr-cache, not call Spark again
            res2 = core.run_make(self.run_dir, "p", fake=False, live=True,
                                 book=str(self.book), scene="tea", from_="story", lang="ru")
            self.assertEqual(transport_calls["translation"], 1,
                             "second run should hit sha256 tr-cache, not translate with Spark")

    def _subs_via_createSubs(self, rows):
        """Feed line/narrator events into engine's createSubs and return subs.log()."""
        # Build a tiny JS runner that imports createSubs via tsx
        events = [r for r in rows if r["type"] in ("line", "narrator")]
        # write events json to temp
        tmp_js = Path(self.tmp.name) / "check_subs.mjs"
        tmp_events = Path(self.tmp.name) / "events.json"
        tmp_events.write_text(json.dumps(events, ensure_ascii=False))
        subs_path = (Path(__file__).resolve().parents[2] / "engine" / "src" / "runtime" / "stage" / "subs.ts").as_posix()
        js = f"""
import {{ createSubs }} from "{subs_path}";
import {{ readFileSync }} from "node:fs";
const events = JSON.parse(readFileSync("{tmp_events.as_posix()}", "utf-8"));
const fakeDoc = {{
  createElement: (tag) => {{
    const el = {{ style: {{}}, className: "", textContent: "", children: [], appendChild(c) {{ this.children.push(c); }}, replaceChildren(...a) {{ this.children = a; }}, setAttribute() {{}} }};
    return el;
  }},
  body: {{ appendChild() {{}} }},
  head: {{ appendChild() {{}} }}
}};
const subs = createSubs(null, fakeDoc);
for (const e of events) {{
  if (e.type === "line") subs.line({{ who: e.who, text: e.text, audio: e.audio }});
  else if (e.type === "narrator") subs.narrator({{ text: e.text, audio: e.audio }});
}}
console.log(JSON.stringify(subs.log()));
"""
        tmp_js.write_text(js)
        res = subprocess.run(["node", "--import", "tsx", str(tmp_js)], capture_output=True, text=True, cwd=str(ENGINE))
        self.assertEqual(res.returncode, 0, f"createSubs failed: stdout={res.stdout!r} stderr={res.stderr!r}")
        try:
            parsed = json.loads(res.stdout.strip().splitlines()[-1])
        except Exception as e:
            self.fail(f"createSubs output not JSON: stdout={res.stdout!r} stderr={res.stderr!r}: {e}")
        self.assertIsInstance(parsed, list, f"createSubs log not list: {parsed!r}")
        return parsed


if __name__ == "__main__":
    unittest.main()
