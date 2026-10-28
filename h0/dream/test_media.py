"""Offline media contract (spec 6, 9, 13, 15 steps 2+4): wav header, Fish/Image fallbacks.
usage: cd h0/dream && python3 -m unittest test_media -q
"""

import json
import os
import shutil
import struct
import tempfile
import threading
import unittest
import wave

import sim
import voice

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out",
                   "dream", "checks", "tmp_test")


def _wav(path, seconds=1.0, rate=8000):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    n = int(seconds * rate)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % n, *[0] * n))


class WavHeaderTest(unittest.TestCase):
    def test_wav_seconds_from_header(self):
        from voice import wav_seconds
        p = os.path.join(TMP, "a.wav")
        _wav(p, seconds=1.25)
        self.assertAlmostEqual(wav_seconds(p), 1.25, places=2)


class FishFallbackTest(unittest.TestCase):
    def _voice(self, failures):
        from voice import Voice
        calls = {"n": 0}

        def transport(text, reference_id, out_path):
            calls["n"] += 1
            raise failures[calls["n"] - 1]
        v = Voice(transport=transport)
        return v, calls

    def test_timeout_then_429_gives_silent_line_with_text_pause_and_tts_fail(self):
        from voice import strip_tags, text_pause
        import urllib.error
        errs = [TimeoutError("t"),
                urllib.error.HTTPError("u", 429, "retry", {}, None),
                urllib.error.HTTPError("u", 429, "retry", {}, None),
                urllib.error.HTTPError("u", 429, "retry", {}, None)]
        v, calls = self._voice(errs)
        out = os.path.join(TMP, "silent.wav")
        if os.path.exists(out):
            os.remove(out)
        res = v.synthesize("[sigh] hello brave <whisper>world</whisper>", "woman", out)
        self.assertFalse(res["ok"])
        self.assertIsNone(res.get("audio"))
        self.assertFalse(os.path.exists(out))
        self.assertEqual(res["diagnostic"], "tts_fail")
        expect = text_pause(strip_tags("[sigh] hello brave <whisper>world</whisper>"))
        self.assertAlmostEqual(res["pause"], expect, places=6)
        # one request + up to three retries (spec 6/13), not three total attempts
        self.assertEqual(calls["n"], 4)

    def test_dream_continues_after_tts_fail(self):
        import urllib.error
        v, _ = self._voice([TimeoutError("t")] * 4)
        out = os.path.join(TMP, "silent2.wav")
        res = v.synthesize("still dreaming", "man", out)
        self.assertFalse(res["ok"])
        # caller keeps the line with a text-based pause: the dream does not stop
        self.assertGreater(res["pause"], 0)


class ImageFallbackTest(unittest.TestCase):
    def test_image_400_three_times_gives_fallback_and_dream_continues(self):
        import urllib.error
        from images import Images
        calls = {"n": 0}

        def transport(prompt, out_path):
            calls["n"] += 1
            raise urllib.error.HTTPError("u", 400, "bad", {}, None)
        im = Images(transport=transport)
        bg = os.path.join(TMP, "bg_fallback.png")
        res = im.generate("background", "porch at dusk", bg, fallback="prev:bg0")
        self.assertFalse(res["ok"])
        self.assertTrue(res.get("fallback"))
        self.assertEqual(calls["n"], 3)
        por = os.path.join(TMP, "por_fallback.png")
        res2 = im.generate("portrait", "Grandma", por, fallback="silhouette:Grandma")
        self.assertFalse(res2["ok"])
        self.assertIn("silhouette", res2["path"])

    def test_no_more_than_two_images_at_once(self):
        import threading
        from images import Images
        live = {"n": 0, "peak": 0}
        lock = threading.Lock()
        from clock import Clock
        clock = Clock(speed=1000.0)

        def transport(prompt, out_path):
            with lock:
                live["n"] += 1
                live["peak"] = max(live["peak"], live["n"])
            clock.sleep(0.05)
            with lock:
                live["n"] -= 1
            with open(out_path, "wb") as f:
                f.write(b"png")
            return out_path
        im = Images(transport=transport, max_parallel=2)
        paths = [os.path.join(TMP, "p%d.png" % i) for i in range(5)]
        threads = [threading.Thread(target=im.generate,
                                    args=("background", "p%d" % i, paths[i]))
                   for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
            self.assertFalse(t.is_alive())
        self.assertLessEqual(live["peak"], 2)


class ImageConcurrencyCapTest(unittest.TestCase):
    def test_max_parallel_capped_at_two(self):
        from images import Images
        im = Images(max_parallel=4)
        self.assertLessEqual(im.max_parallel, 2)
        self.assertLessEqual(im._sem._value, 2)


class StripTagsTest(unittest.TestCase):
    def test_double_bracket_tag_removed_fully(self):
        from voice import strip_tags, text_pause
        cleaned = strip_tags("hello [[LOOK:clarinet]] there")
        self.assertNotIn("]", cleaned)
        self.assertNotIn("[", cleaned)
        self.assertAlmostEqual(text_pause(cleaned), 2 / 2.5 + 1.0, places=6)

    def test_angle_and_single_brackets_stripped(self):
        from voice import strip_tags
        cleaned = strip_tags("[sigh] hello <whisper>world</whisper>")
        self.assertNotIn("[", cleaned)
        self.assertNotIn("<", cleaned)


class FishRetryTest(unittest.TestCase):
    def test_wrapped_timeout_retries_then_third_succeeds(self):
        import urllib.error
        from voice import Voice
        calls = {"n": 0}

        def transport(text, reference_id, out_path):
            calls["n"] += 1
            if calls["n"] < 3:
                if calls["n"] == 1:
                    raise urllib.error.URLError(TimeoutError("timed out"))
                raise TimeoutError("t")
            _wav(out_path, seconds=1.0)
            return out_path
        v = Voice(transport=transport)
        out = os.path.join(TMP, "retry3.wav")
        if os.path.exists(out):
            os.remove(out)
        res = v.synthesize("hello world", "woman", out)
        self.assertTrue(res["ok"])
        self.assertEqual(calls["n"], 3)

    def test_fourth_attempt_succeeds_after_three_retryable_failures(self):
        import urllib.error
        from voice import Voice
        calls = {"n": 0}

        def transport(text, reference_id, out_path):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.URLError(TimeoutError("timed out"))
            if calls["n"] in (2, 3):
                raise urllib.error.HTTPError("u", 503, "down", {}, None)
            _wav(out_path, seconds=1.0)
            return out_path
        v = Voice(transport=transport)
        out = os.path.join(TMP, "retry4.wav")
        if os.path.exists(out):
            os.remove(out)
        res = v.synthesize("hello world", "woman", out)
        self.assertTrue(res["ok"])
        self.assertEqual(calls["n"], 4)


class VoiceLabelFallbackTest(unittest.TestCase):
    def test_unknown_label_never_forwarded_literally_to_fish(self):
        from voice import Voice
        pool = {"man": "abc123", "woman": "def456"}
        v = Voice(pool=pool)
        self.assertEqual(v.reference_id("plankton"), "abc123")
        self.assertNotEqual(v.reference_id("plankton"), "plankton")


class SilentPauseSlotTest(unittest.TestCase):
    def test_silent_line_uses_tag_free_pause(self):
        from sim import Sim
        sim = Sim(profile="A", fake=True, speed=1000.0)
        try:
            from voice import strip_tags, text_pause
            text = "hello [[LOOK:clarinet]] there <whisper>quiet</whisper>"
            line = {"owner": "npc", "text": text}
            expect = text_pause(strip_tags(text))
            # emulate a failed TTS result wired into _start_line timing
            import voice as _vmod

            class _V:
                def synthesize(self, t, label, path):
                    return {"ok": False, "audio": None,
                            "pause": text_pause(strip_tags(t)),
                            "diagnostic": "tts_fail",
                            "error": {"type": "tts_fail", "error": "boom"}}
            sim._voice = _V()
            sim.fake = False
            sim._audio_dir = TMP
            import tempfile as _tf
            d = _tf.mkdtemp()
            from sim import Logger
            sim.outdir = d
            sim.logger = Logger(os.path.join(d, "log.jsonl"))
            sim._audio_dir = d
            sim._start_line(dict(line))
            self.assertAlmostEqual(sim._line_duration, sim.clock.scale(expect),
                                   places=6)
            sim.close()
        finally:
            try:
                sim.close()
            except Exception:
                pass


class FallbackFileTest(unittest.TestCase):
    def test_image_fallback_none_is_real_file(self):
        import urllib.error
        from images import Images
        def transport(prompt, out_path):
            raise urllib.error.HTTPError("u", 400, "bad", {}, None)
        im = Images(transport=transport)
        bg = os.path.join(TMP, "bg_nofb.png")
        if os.path.exists(bg):
            os.remove(bg)
        res = im.generate("background", "porch at dusk", bg, fallback=None)
        self.assertFalse(res["ok"])
        self.assertTrue(os.path.exists(res["path"]),
                        "background fallback must be a real file (spec 9: sim log paths exist)")
        with open(res["path"], "rb") as f:
            self.assertTrue(f.read(4).startswith(b"\x89PNG"))
        por = os.path.join(TMP, "por_nofb.png")
        if os.path.exists(por):
            os.remove(por)
        res2 = im.generate("portrait", "Grandma", por, fallback=None)
        self.assertFalse(res2["ok"])
        self.assertTrue(os.path.exists(res2["path"]),
                        "portrait fallback must be a real file (spec 9: silhouette)")
        self.assertGreater(os.path.getsize(res2["path"]), 8)


class PngFallbackNoPillowTest(unittest.TestCase):
    def test_caption_and_silhouette_are_valid_png_without_pillow(self):
        import sys
        import zlib
        from images import Images
        old = sys.modules.get("PIL")
        sys.modules["PIL"] = None  # force ImportError on `from PIL import ...`
        try:
            im = Images(transport=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
            cap = os.path.join(TMP, "cap_nopil.png")
            sil = os.path.join(TMP, "sil_nopil.png")
            im._write_caption(cap, "a place")
            im._write_silhouette(sil, "Grandma")
            for p in (cap, sil):
                with open(p, "rb") as f:
                    data = f.read()
                self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
                self.assertEqual(data[12:16], b"IHDR")
                idat_start = data.index(b"IDAT")
                idat_len = struct.unpack(">I", data[idat_start - 4:idat_start])[0]
                idat = data[idat_start + 4:idat_start + 4 + idat_len]
                zlib.decompress(idat)  # must not raise: real deflate data
        finally:
            if old is not None:
                sys.modules["PIL"] = old
            else:
                sys.modules.pop("PIL", None)


class SimActorVoiceTest(unittest.TestCase):
    def test_npc_line_uses_assigned_actor_voice_not_hardcoded_man(self):
        from sim import Sim, Logger
        import tempfile as _tf
        calls = []

        class _V:
            def synthesize(self, text, label, path):
                calls.append(label)
                return {"ok": False, "audio": None, "pause": 1.0,
                        "diagnostic": "tts_fail", "error": {"type": "tts_fail", "error": "x"}}
        sim = Sim(profile="A", fake=True, speed=1000.0)
        try:
            sim.fake = False
            sim._voice = _V()
            d = _tf.mkdtemp()
            sim.outdir = d
            sim.logger = Logger(os.path.join(d, "log.jsonl"))
            sim._audio_dir = d
            sim._actor_voices = {"Grandma": "old_woman"}
            sim.actors = ["Grandma"]
            sim._start_line({"owner": "npc", "text": "hello"})
            self.assertEqual(calls, ["old_woman"])
        finally:
            sim.close()


class BackgroundPromptContractTest(unittest.TestCase):
    def test_background_uses_background_prompt_with_style_and_destination(self):
        from sim import Sim, Logger
        from images import background_prompt
        import tempfile as _tf
        captured = {}

        class _Img:
            def generate(self, kind, prompt, out_path, fallback=None, name=None):
                if kind == "background":
                    captured["kind"] = kind
                    captured["prompt"] = prompt
                with open(out_path, "wb") as f:
                    f.write(b"\x89PNG\r\n\x1a\n")
                return {"ok": True, "path": out_path}
        sim = Sim(profile="A", fake=True, speed=1000.0)
        try:
            sim.fake = False
            sim._images = _Img()
            d = _tf.mkdtemp()
            sim.outdir = d
            sim.logger = Logger(os.path.join(d, "log.jsonl"))
            sim._image_dir = d
            sim.fsm.destination = "grandma's porch at dusk"
            sim.fsm.next_scene = {"objects": ["a", "b", "c", "d", "e"],
                                  "actors": [{"name": "Grandma", "voice": "old_woman"}]}
            sim._apply_transition()
            sim.wait_images()
            self.assertEqual(captured["kind"], "background")
            self.assertEqual(captured["prompt"], background_prompt("grandma's porch at dusk"))
            self.assertEqual(sim._actor_voices.get("Grandma"), "old_woman")
        finally:
            sim.close()


class ImageEventDurationTest(unittest.TestCase):
    def test_image_event_logs_start_and_duration(self):
        from sim import Sim, Logger
        import tempfile as _tf

        class _Img:
            def generate(self, kind, prompt, out_path, fallback=None):
                with open(out_path, "wb") as f:
                    f.write(b"\x89PNG\r\n\x1a\n")
                return {"ok": True, "path": out_path}
        sim = Sim(profile="A", fake=True, speed=1000.0)
        try:
            sim.fake = False
            sim._images = _Img()
            d = _tf.mkdtemp()
            sim.outdir = d
            sim.logger = Logger(os.path.join(d, "log.jsonl"))
            sim._image_dir = d
            sim.fsm.destination = "grandma's porch at dusk"
            sim.fsm.next_scene = {"objects": ["a", "b", "c", "d", "e"],
                                  "actors": [{"name": "Grandma", "voice": "old_woman"}]}
            sim._apply_transition()
            sim.wait_images()
            with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            img_rows = [r for r in rows if r["type"] == "image"
                        and r.get("kind") == "background"]
            self.assertEqual(len(img_rows), 1)
            self.assertIn("dur", img_rows[0])
            self.assertGreaterEqual(img_rows[0]["dur"], 0)
        finally:
            sim.close()


class DirectorLiveCallTest(unittest.TestCase):
    def test_live_mode_asks_llm_instead_of_script(self):
        from director import Director
        from fsm import BuildFSM
        from clock import Clock
        from unittest.mock import patch

        clock = Clock(speed=1000.0)
        fsm = BuildFSM(["clarinet"], voices={"man"}, speed=1000.0, now=clock.now(),
                       actors=["Squidward"])
        calls = []

        class FakeResult:
            text = '{"bridge": null, "messages": []}'
            usage = {"prompt_tokens": 1, "completion_tokens": 1}

        def fake_call(role, system, messages, max_tokens=300, **kw):
            calls.append((role, messages))
            return FakeResult()

        with patch("director.llm_call", fake_call):
            d = Director(fsm, actors=["Squidward"], fake=False, clock=clock)
            d.consult_async(clock.now())
            d.wait(2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "director")
        self.assertFalse(d.in_flight)


class ImageDoesNotBlockDreamTest(unittest.TestCase):
    """Spec 9: a picture is never on the critical path of the dream."""

    def _sim(self, images):
        from sim import Sim, Logger
        import tempfile as _tf
        sim = Sim(profile="A", fake=True, speed=1000.0)
        sim.fake = False
        sim._images = images
        d = _tf.mkdtemp()
        sim.outdir = d
        sim.logger = Logger(os.path.join(d, "log.jsonl"))
        sim._image_dir = d
        sim.fsm.destination = "grandma's porch at dusk"
        sim.fsm.next_scene = {"objects": ["a", "b", "c", "d", "e"],
                              "actors": [{"name": "Grandma", "voice": "old_woman"}]}
        return sim, d

    def test_transition_returns_while_image_is_still_generating(self):
        release = threading.Event()
        finished = threading.Event()

        class _Img:
            def generate(self, kind, prompt, out_path, fallback=None):
                release.wait(1.0)
                with open(out_path, "wb") as f:
                    f.write(b"\x89PNG\r\n\x1a\n")
                finished.set()
                return {"ok": True, "path": out_path}

        sim, d = self._sim(_Img())
        try:
            sim._apply_transition()
            self.assertFalse(finished.is_set(),
                             "transition must not wait for the picture (spec 9)")
            release.set()
        finally:
            sim.close()
        self.assertTrue(finished.is_set(), "close() must finish owned image workers")
        rows = []
        with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        img_rows = [r for r in rows if r["type"] == "image"
                    and r.get("kind") == "background"]
        self.assertEqual(len(img_rows), 1)
        self.assertTrue(os.path.exists(os.path.join(d, img_rows[0]["path"])),
                        "logged image path must exist under outdir (spec 4)")

    def test_failed_image_is_logged_with_fallback_file_on_disk(self):
        class _Img:
            def generate(self, kind, prompt, out_path, fallback=None):
                with open(out_path, "wb") as f:
                    f.write(b"\x89PNG\r\n\x1a\n")
                return {"ok": False, "path": out_path, "fallback": out_path,
                        "diagnostic": {"type": "image_fail"}}

        sim, d = self._sim(_Img())
        try:
            sim._apply_transition()
        finally:
            sim.close()
        with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
            img_rows = [json.loads(l) for l in f
                        if json.loads(l)["type"] == "image"
                        and json.loads(l).get("kind") == "background"]
        self.assertEqual(len(img_rows), 1)
        self.assertIn("fallback", img_rows[0])
        self.assertTrue(os.path.exists(os.path.join(d, img_rows[0]["fallback"])))



class _CapImages:
    """Records every image request; writes a real file so sim logging works."""

    def __init__(self):
        self.calls = []

    def generate(self, kind, prompt, out_path, fallback=None, name=None):
        self.calls.append({"kind": kind, "prompt": prompt, "name": name,
                           "path": out_path})
        with open(out_path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
        return {"ok": True, "path": out_path}


def _live_sim(images=None, voice=None):
    """Sim wired for live media into a temp outdir (the offline flip idiom)."""
    from sim import Sim, Logger
    import tempfile as _tf
    sim = Sim(profile="A", fake=True, speed=1000.0)
    sim.fake = False
    if images is not None:
        sim._images = images
    if voice is not None:
        sim._voice = voice
    d = _tf.mkdtemp()
    sim.outdir = d
    sim.logger = Logger(os.path.join(d, "log.jsonl"))
    sim._image_dir = d
    sim._audio_dir = d
    return sim, d


class _FailVoice:
    def __init__(self):
        self.labels = []

    def synthesize(self, text, label, path):
        from voice import strip_tags, text_pause
        self.labels.append(label)
        return {"ok": False, "audio": None, "pause": text_pause(strip_tags(text)),
                "diagnostic": "tts_fail", "error": {"type": "tts_fail",
                                                    "error": "RuntimeError: boom"}}


class SceneBackgroundTimingTest(unittest.TestCase):
    """F1 / spec 9: the opening scene has a background, and the destination's
    background starts when the build starts, not after the transition."""

    def test_start_background_exists_and_destination_starts_during_build(self):
        img = _CapImages()
        sim, d = _live_sim(images=img)
        try:
            sim._tick()
            sim.wait_images()
            bgs = [c for c in img.calls if c["kind"] == "background"]
            self.assertEqual(len(bgs), 1)
            self.assertTrue(os.path.exists(bgs[0]["path"]))
            sim.fsm.start_build(sim.clock.now(), "clarinet", "grandma's porch")
            sim._tick()
            sim.wait_images()
            bgs = [c for c in img.calls if c["kind"] == "background"]
            self.assertEqual(len(bgs), 2)
            from images import background_prompt
            self.assertEqual(bgs[1]["prompt"],
                             background_prompt("grandma's porch"))
            # the transition must not ask for the same background a second time
            sim.fsm.next_scene = {"objects": ["a", "b", "c", "d", "e"], "actors": []}
            sim._apply_transition()
            sim.wait_images()
            self.assertEqual(len([c for c in img.calls
                                  if c["kind"] == "background"]), 2)
        finally:
            sim.close()


class PortraitTest(unittest.TestCase):
    """F2 / spec 9 R2-R3: new actors and a changed hero get portraits."""

    def test_new_actor_and_changed_hero_get_logged_portraits(self):
        img = _CapImages()
        sim, d = _live_sim(images=img)
        try:
            sim.fsm.destination = "grandma's porch"
            sim.fsm.next_scene = {"objects": ["a", "b", "c", "d", "e"],
                                  "actors": [{"name": "Grandma",
                                              "voice": "old_woman"}]}
            sim.fsm.hero_next = {"changes": True, "description": "wearing a coat"}
            sim._apply_transition()
            sim.wait_images()
            portraits = [c for c in img.calls if c["kind"] == "portrait"]
            self.assertEqual(sorted(c["name"] for c in portraits),
                             ["Grandma", "SpongeBob, wearing a coat"])
            for c in portraits:
                self.assertTrue(os.path.exists(c["path"]))
            with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            logged = [r for r in rows
                      if r["type"] == "image" and r.get("kind") == "portrait"]
            self.assertEqual(len(logged), 2)
            for r in logged:
                self.assertTrue(os.path.exists(os.path.join(d, r["path"])))
                self.assertIn("who", r)
        finally:
            sim.close()


class BudgetHoldTest(unittest.TestCase):
    """F3 / spec 13: the limit stops new paid requests instead of noticing
    afterwards that it was passed."""

    def test_spent_limit_blocks_new_paid_requests_and_wakes_hero(self):
        import llm
        img = _CapImages()
        voice = _FailVoice()
        sim, d = _live_sim(images=img, voice=voice)
        llm.reset_spent()
        try:
            sim.max_dollars = 0.000001
            llm._charge(0.01)
            self.assertFalse(sim._budget_ok())
            self.assertTrue(sim.budget_wake)
            sim._tick()
            sim.wait_images()
            self.assertEqual(img.calls, [], "no new paid image past the limit")
            sim._start_line({"owner": "npc", "text": "hello"})
            self.assertEqual(voice.labels, [], "no new paid tts past the limit")
            with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            wake = [r for r in rows if r["type"] == "wake_up"]
            self.assertTrue(wake)
            self.assertEqual(wake[0].get("reason"), "budget")
        finally:
            llm.reset_spent()
            sim.close()


class HeroVoiceTest(unittest.TestCase):
    """F4 / spec 6: the hero speaks with the profile's voice, and a cartoon
    label resolves to its Fish reference_id instead of collapsing to "man"."""

    def test_profile_hero_voice_used_and_resolved_to_fish_id(self):
        from voice import Voice, load_pool
        v = Voice(pool=load_pool())
        self.assertEqual(v.reference_id("spongebob"),
                         "0051da373e0a4ac282399909d1d31b69")
        voice = _FailVoice()
        sim, d = _live_sim(voice=voice)
        try:
            sim._start_line({"owner": "human", "text": "it was not my fault"})
            self.assertEqual(voice.labels, ["spongebob"])
        finally:
            sim.close()


class FallbackCaptionTest(unittest.TestCase):
    """F5 / spec 9: the fallback background carries the new place as caption and
    the fallback portrait carries the character name, Pillow or not."""

    def _failing(self):
        import urllib.error
        from images import Images

        def transport(prompt, out_path):
            raise urllib.error.HTTPError("u", 400, "bad", {}, None)
        return Images(transport=transport)

    def _check(self, im, suffix):
        bg0 = os.path.join(TMP, "bg_src%s.png" % suffix)
        im._write_caption(bg0, "the first place")
        im.prev_background = bg0
        bg = os.path.join(TMP, "bg_cap%s.png" % suffix)
        res = im.generate("background", "a long muse prompt about a place", bg,
                          name="grandma's porch at dusk")
        self.assertFalse(res["ok"])
        with open(res["path"], "rb") as f:
            data = f.read()
        self.assertIn(b"grandma's porch at dusk", data,
                      "fallback background must caption the new place")
        por = os.path.join(TMP, "por_cap%s.png" % suffix)
        res2 = im.generate("portrait", "a long muse prompt about a person", por,
                           name="Grandma")
        with open(res2["path"], "rb") as f:
            data2 = f.read()
        self.assertIn(b"Grandma", data2, "silhouette must carry the name")
        self.assertNotIn(b"a long muse prompt", data2,
                         "silhouette must carry the name, not the prompt")

    def test_caption_and_name_with_pillow(self):
        self._check(self._failing(), "_pil")

    def test_caption_and_name_without_pillow(self):
        import sys
        old = sys.modules.get("PIL")
        sys.modules["PIL"] = None
        try:
            self._check(self._failing(), "_nopil")
        finally:
            if old is not None:
                sys.modules["PIL"] = old
            else:
                sys.modules.pop("PIL", None)


class SimContinuesAfterTtsFailTest(unittest.TestCase):
    """F6 / spec 6+13: a dead Fish leaves silent lines, the loop keeps going."""

    def test_loop_keeps_starting_lines_after_tts_fail(self):
        voice = _FailVoice()
        sim, d = _live_sim(voice=voice)
        try:
            for _ in range(60):
                sim._tick()
                sim._maybe_generate_line()
                sim.clock.real_sleep(0.001)
        finally:
            sim.close()
        with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        lines = [r for r in rows if r["type"] == "line"]
        fails = [r for r in rows if r["type"] == "tts_fail"]
        self.assertGreaterEqual(len(lines), 2, "the dream must keep speaking")
        self.assertGreaterEqual(len(fails), 2)
        for r in lines:
            self.assertTrue(r.get("silent"))
            self.assertNotIn("audio", r)
            self.assertGreater(r["dur"], 0)


class DirectorSchemaTargetTest(unittest.TestCase):
    """A live decision is only buildable if the whole target block is asked for
    (spec 8): without next_scene every live consult is rejected as invalid and
    the dream never transitions."""

    def test_schema_asks_for_every_target_field_and_the_voice_pool(self):
        from director import DIRECTOR_SCHEMA
        from fsm import TARGET
        for field in TARGET:
            self.assertIn(field, DIRECTOR_SCHEMA)
        for label in ("old_woman", "old_man", "woman", "man", "child", "creature"):
            self.assertIn(label, DIRECTOR_SCHEMA)

    def test_schema_shaped_reply_passes_the_fsm_target_check(self):
        from fsm import check_target
        decision = {"bridge": "clarinet", "destination": "the porch",
                    "why": "the diary lullaby", "messages": [],
                    "next_scene": {"objects": ["a", "b", "c", "d", "e"],
                                   "actors": [{"name": "Grandma",
                                               "voice": "old_woman"}]},
                    "hero_next": {"changes": False},
                    "facts_update": [], "abort_build": None, "wake_up": None}
        self.assertIsNone(check_target(decision, ["clarinet"],
                                       {"old_woman", "man"}))


if __name__ == "__main__":
    unittest.main()


class VerifyRunTest(unittest.TestCase):
    """Phase contract step 4: the live run checks its own log -- every logged
    file on disk, line `dur` equal to the wav header length within 0.05 s and
    `cost` within --max-dollars (spec 13, 15 step 4)."""

    def _run_dir(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        return d

    def _write_log(self, outdir, rows):
        path = os.path.join(outdir, "log.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        return path

    def _wav(self, outdir, rel, seconds):
        path = os.path.join(outdir, rel)
        voice._write_silent_wav(path, seconds)
        return voice.wav_seconds(path)

    def test_clean_run_verifies(self):
        d = self._run_dir()
        secs = self._wav(d, "audio/line_001.wav", 1.5)
        open(os.path.join(d, "bg.png"), "wb").close()
        log = self._write_log(d, [
            {"type": "line", "turn_owner": "npc", "text": "hi",
             "dur": secs, "audio": "audio/line_001.wav"},
            {"type": "image", "kind": "background", "path": "bg.png"},
            {"type": "cost", "dollars": 1.2, "max_dollars": 2.0},
        ])
        rep = sim.verify_run(d, log, max_dollars=2.0)
        self.assertEqual(rep["issues"], [])
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["checked_files"], 2)

    def test_missing_logged_file_is_an_issue(self):
        d = self._run_dir()
        log = self._write_log(d, [
            {"type": "image", "kind": "background", "path": "gone.png"}])
        rep = sim.verify_run(d, log, max_dollars=2.0)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("gone.png" in i for i in rep["issues"]), rep["issues"])

    def test_dur_off_from_wav_length_is_an_issue(self):
        d = self._run_dir()
        secs = self._wav(d, "audio/line_001.wav", 1.5)
        log = self._write_log(d, [
            {"type": "line", "turn_owner": "npc", "text": "hi",
             "dur": secs + 0.2, "audio": "audio/line_001.wav"}])
        rep = sim.verify_run(d, log, max_dollars=2.0)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("dur" in i for i in rep["issues"]), rep["issues"])

    def test_dur_within_tolerance_passes(self):
        d = self._run_dir()
        secs = self._wav(d, "audio/line_001.wav", 1.5)
        log = self._write_log(d, [
            {"type": "line", "turn_owner": "npc", "text": "hi",
             "dur": secs + 0.04, "audio": "audio/line_001.wav"}])
        self.assertEqual(sim.verify_run(d, log, max_dollars=2.0)["issues"], [])

    def test_cost_over_limit_is_an_issue(self):
        d = self._run_dir()
        log = self._write_log(d, [
            {"type": "cost", "dollars": 2.5, "max_dollars": 2.0}])
        rep = sim.verify_run(d, log, max_dollars=2.0)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("cost" in i for i in rep["issues"]), rep["issues"])
        self.assertAlmostEqual(rep["spent"], 2.5)

    def test_silent_line_dur_is_not_compared_to_a_wav(self):
        d = self._run_dir()
        log = self._write_log(d, [
            {"type": "line", "turn_owner": "npc", "text": "hi",
             "dur": 1.4, "silent": True}])
        self.assertEqual(sim.verify_run(d, log, max_dollars=2.0)["issues"], [])


class StartSceneMediaTest(unittest.TestCase):
    """F1+F3 / spec 9: the opening scene is the one in scenes/start.json, and the
    hero and the actor already on stage are introduced by portraits before the
    first transition -- not only after it."""

    def _start_json(self):
        path = os.path.join(os.path.dirname(os.path.abspath(sim.__file__)),
                            "scenes", "start.json")
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def test_start_background_uses_start_json_place_and_objects(self):
        from images import background_prompt
        scene = self._start_json()
        img = _CapImages()
        s, _d = _live_sim(images=img)
        try:
            s._tick()
            s.wait_images()
            bgs = [c for c in img.calls if c["kind"] == "background"]
            self.assertEqual(len(bgs), 1)
            prompt = bgs[0]["prompt"]
            self.assertTrue(prompt.startswith(background_prompt("")[:40]), prompt)
            self.assertIn(scene["place"], prompt)
            for obj in scene["objects"]:
                self.assertIn(obj, prompt)
        finally:
            s.close()

    def test_start_scene_portraits_before_any_transition(self):
        scene = self._start_json()
        img = _CapImages()
        s, d = _live_sim(images=img)
        try:
            s._tick()
            s.wait_images()
            portraits = [c for c in img.calls if c["kind"] == "portrait"]
            names = " | ".join(c["name"] for c in portraits)
            self.assertIn(s.hero, names)
            for actor in scene["actors"]:
                self.assertIn(actor["name"], names)
            self.assertEqual(s.n_transitions, 0)
            with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            logged = [r for r in rows
                      if r["type"] == "image" and r.get("kind") == "portrait"]
            self.assertEqual(len(logged), len(portraits))
            for r in logged:
                self.assertTrue(os.path.exists(os.path.join(d, r["path"])))
            # a second tick must not redraw the same faces
            s._tick()
            s.wait_images()
            self.assertEqual(len([c for c in img.calls
                                  if c["kind"] == "portrait"]), len(portraits))
        finally:
            s.close()

    def test_start_actor_voice_comes_from_start_json(self):
        scene = self._start_json()
        s, _d = _live_sim()
        try:
            for actor in scene["actors"]:
                self.assertEqual(s._actor_voices.get(actor["name"]),
                                 actor["voice"])
        finally:
            s.close()


class HeroChangeTest(unittest.TestCase):
    """F2 / spec 9 R3: a changed hero is drawn from his NEW look (the old one is
    only a reference) and keeps speaking with the voice the director gave him."""

    def test_changed_hero_portrait_uses_new_look_and_new_voice(self):
        img = _CapImages()
        s, _d = _live_sim(images=img)
        try:
            s._tick()
            s.wait_images()
            before = len(img.calls)
            s.fsm.destination = "grandma's porch"
            s.fsm.next_scene = {"objects": ["a", "b", "c", "d", "e"], "actors": []}
            s.fsm.hero_next = {"changes": True, "description": "a boy in a diver suit",
                               "voice": "man"}
            s._apply_transition()
            s.wait_images()
            new = [c for c in img.calls[before:] if c["kind"] == "portrait"]
            self.assertEqual(len(new), 1)
            self.assertIn("a boy in a diver suit", new[0]["prompt"])
            self.assertIn("a boy in a diver suit", new[0]["name"])
            # Muse Image filters known character names: the name labels the
            # portrait, the prompt carries only looks
            self.assertIn(s.hero, new[0]["name"])
            self.assertNotIn(s.hero, new[0]["prompt"])
            self.assertEqual(s.hero_voice, "man")
            self.assertEqual(s._hero_desc, "a boy in a diver suit")
        finally:
            s.close()


class _ChargingImages:
    """Image stub that spends money late: the file lands, then the charge does."""

    def __init__(self, dollars=0.5, gate=None):
        self.dollars = dollars
        self.gate = gate
        self.calls = []

    def generate(self, kind, prompt, out_path, fallback=None, name=None):
        import llm
        self.calls.append(kind)
        if self.gate is not None:
            self.gate.wait(5.0)
        with open(out_path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
        llm._charge(self.dollars)
        return {"ok": True, "path": out_path}


class LateCostTest(unittest.TestCase):
    """F5 / spec 13+15 step 4: the final `cost` line is written after every task
    that can still spend money, the limit counts work already in flight, and
    verify_run compares the journal with what was really spent."""

    def test_final_cost_row_includes_a_late_image_charge(self):
        import llm
        img = _ChargingImages(0.5)
        s, d = _live_sim(images=img)
        llm.reset_spent()
        try:
            s._tick()
            s.run(max_transitions=0, max_seconds=0.05)
            with open(os.path.join(d, "log.jsonl"), encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            costs = [r for r in rows if r["type"] == "cost"]
            self.assertTrue(costs)
            self.assertAlmostEqual(costs[-1]["dollars"], llm.get_spent())
            self.assertGreaterEqual(costs[-1]["dollars"], 0.5)
        finally:
            llm.reset_spent()
            s.close()

    def test_budget_counts_images_already_in_flight(self):
        import llm
        gate = threading.Event()
        img = _ChargingImages(0.01, gate=gate)
        s, _d = _live_sim(images=img)
        llm.reset_spent()
        try:
            s.max_dollars = 0.015
            s._tick()
            self.assertEqual(len(img.calls), 1)
            self.assertFalse(s._budget_ok(),
                             "an unfinished paid image must count against the limit")
        finally:
            gate.set()
            s.wait_images()
            llm.reset_spent()
            s.close()

    def test_verify_run_flags_spend_the_journal_missed(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        log = os.path.join(d, "log.jsonl")
        with open(log, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "cost", "dollars": 0.0,
                                "max_dollars": 0.1}) + "\n")
        rep = sim.verify_run(d, log, max_dollars=0.1, actual_spent=0.5)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("0.5" in i or "actual" in i for i in rep["issues"]),
                        rep["issues"])


class DirectorNeedleContractTest(unittest.TestCase):
    """F4+F6 / phase step 2: the needle is a fact from the dream's first minutes
    that the soul file does not contain, and a `why` that only waves at "the
    diary" is not accepted as a reference to the soul."""

    def _soul_text(self, pid):
        import director_live_check as dlc
        p = dlc.load_profile(pid)
        parts = [p.get("diary", ""), p.get("past_dream", "")]
        parts += list(p.get("wants", [])) + list(p.get("fears", []))
        parts += [f.get("text", "") for f in p.get("facts", [])]
        return " ".join(parts).lower()

    def test_needle_is_an_early_event_absent_from_the_soul(self):
        import director_live_check as dlc
        for pid in ("A", "B", "C"):
            soul = self._soul_text(pid)
            needle = dlc.NEEDLE[pid].lower()
            key = dlc.NEEDLE_KEY[pid].lower()
            self.assertNotIn(key, soul, pid)
            self.assertNotIn(needle, soul, pid)
            prompt = dlc.slice_prompt(dlc.load_profile(pid))
            self.assertIn(dlc.NEEDLE[pid], prompt, pid)
            # the needle sits in the first episode, the 3rd transition comes later
            self.assertLess(prompt.index(dlc.NEEDLE[pid]), prompt.index("3rd transition"))
            self.assertIn(dlc.EXPECT_DEST[pid], dlc.CANDIDATES[pid], pid)
            others = [c for c in dlc.CANDIDATES[pid] if c != dlc.EXPECT_DEST[pid]]
            self.assertTrue(others, pid)
            for c in others:
                self.assertNotIn(key, c.lower(), pid)

    def test_generic_diary_why_is_rejected(self):
        import director_live_check as dlc
        ok, _ = dlc.why_ok("A", "The diary and the past dream decided it.",
                           "clarinet", "grandma's porch in the fog")
        self.assertFalse(ok)

    def test_why_naming_a_soul_fact_tied_to_the_bridge_passes(self):
        import director_live_check as dlc
        ok, reason = dlc.why_ok(
            "A", "The clarinet still carries the lullaby his grandma sang.",
            "clarinet", "grandma's porch in the fog")
        self.assertTrue(ok, reason)

    def test_soul_fact_unrelated_to_bridge_or_place_is_rejected(self):
        import director_live_check as dlc
        ok, _ = dlc.why_ok("A", "He hummed a lullaby on the bus.",
                           "old radio", "the factory floor")
        self.assertFalse(ok)
