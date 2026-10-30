"""Red tests for blocking findings F1-F4 (phase 2.2)."""
import json
import os
import tempfile
import threading
import unittest

import safety


class F1OutcomeTest(unittest.TestCase):
    def test_event_outcome_triggers_pause(self):
        from sim import Sim
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        s = Sim(fake=True, outdir=tmp.name)
        self.addCleanup(s.close)
        s.post_event({"source": "tool", "value": "clicked",
                      "outcome": "I want to die"})
        self.assertTrue(s.safety_paused)


class F4AnnotationsTest(unittest.TestCase):
    def test_annotations(self):
        self.assertEqual(safety.PHRASES.__class__, dict)
        ann = getattr(safety, "__annotations__", {})
        self.assertIn("PHRASES", ann)
        self.assertIn("return", safety.match.__annotations__)


class F6ImageRaceTest(unittest.TestCase):
    def test_image_write_in_flight_at_pause_logs_after_safety_pause(self):
        """F6 repro: a safety pause started while an image worker is already
        inside its write call must not let that image's log line land before
        safety_pause -- check and write have to share the pause's lock."""
        from sim import Sim

        entered, release = threading.Event(), threading.Event()

        class Images:
            def generate(self, kind, prompt, path, fallback=None, name=None):
                with open(path, "wb") as f:
                    f.write(b"x")
                return {"ok": True, "path": path}

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        s = Sim(fake=True, outdir=tmp.name)
        self.addCleanup(s.close)
        original = s.logger.write_event

        def delayed_write(event):
            if event.get("type") == "image":
                entered.set()
                release.wait(2)
            return original(event)

        s.logger.write_event = delayed_write
        s._images = Images()
        s._start_image("background", "x", os.path.join(tmp.name, "x.png"), "x")
        self.assertTrue(entered.wait(2))
        s.human_say("I want to die")
        release.set()
        s.wait_images()
        with open(os.path.join(tmp.name, "log.jsonl"), encoding="utf-8") as f:
            types = [json.loads(line)["type"] for line in f]
        self.assertIn("safety_pause", types)
        self.assertIn("image", types)
        self.assertLess(types.index("safety_pause"), types.index("image"))


class F7DirectorRaceTest(unittest.TestCase):
    def test_in_flight_consult_does_not_apply_after_pause(self):
        """F7 repro: a consult started before the pause must not mutate the
        fsm (wake_up -> fsm.awake) once it finishes after safety_paused."""
        from sim import Sim

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        s = Sim(fake=True, outdir=tmp.name, delay=0.15,
                script=[{"wake_up": "test"}])
        self.addCleanup(s.close)
        s.director.consult_async(s.clock.now())
        s.human_say("I want to die")
        s.director.wait(timeout=2)
        self.assertTrue(s.safety_paused)
        self.assertFalse(s.fsm.awake)


class F23ComicTest(unittest.TestCase):
    def test_comic_freezes_and_stops_audio(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "comic.html"), encoding="utf-8") as f:
            page = f.read()
        # F2: pause stops active audio and drops the queue
        self.assertIn("audioQ.length = 0", page)
        self.assertIn("audioEl.pause()", page)
        # F3: displayed time frozen on pause
        self.assertIn("paused", page)
        self.assertIn("frozenT", page)


class F9PauseFlagOrderTest(unittest.TestCase):
    def test_flag_is_set_before_safety_pause_is_logged(self):
        """F9 repro: the pause flag has to be up before the safety_pause row is
        written. Otherwise a consult (or an image) finishing while that write is
        in progress still sees an unpaused dream and applies its wake_up."""
        from sim import Sim

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        s = Sim(fake=True, outdir=tmp.name, delay=0.05,
                script=[{"wake_up": "test"}])
        self.addCleanup(s.close)

        entered, release = threading.Event(), threading.Event()
        original = s.logger.write_event

        def blocked(event):
            if event.get("type") == "safety_pause":
                entered.set()
                release.wait(2)
            return original(event)

        s.logger.write_event = blocked
        self.addCleanup(release.set)
        s.director.consult_async(s.clock.now())
        user = threading.Thread(target=lambda: s.human_say("I want to die"))
        user.start()
        self.assertTrue(entered.wait(2))
        s.director.wait(timeout=2)
        release.set()
        user.join(2)
        self.assertTrue(s.safety_paused)
        self.assertFalse(s.fsm.awake)
