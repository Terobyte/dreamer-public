"""make.film: the recorded page has no sound (Playwright never captures audio); every voiced event's wav is laid
under the picture at the moment the page got it, the film ends just after book_end."""
import tempfile
import unittest
from pathlib import Path

from make import film


def _wav(d, name):
    p = Path(d) / "audio" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"RIFF")
    return f"audio/{name}"


class MuxCmd(unittest.TestCase):
    def setUp(self):
        self.sim = tempfile.mkdtemp()

    def _filter(self, args):
        return args[args.index("-filter_complex") + 1]

    def test_each_voice_at_its_moment_and_end_after_book_end(self):
        a, b = _wav(self.sim, "line_001.wav"), _wav(self.sim, "line_002.wav")
        events = [{"ms": 1200, "type": "narrator", "audio": a}, {"ms": 5300, "type": "line", "audio": b},
                  {"ms": 9000, "type": "book_end"}, {"ms": 9500, "type": "cost"}]
        args = film.mux_cmd("v.webm", events, self.sim, "out.mp4")
        f = self._filter(args)
        self.assertIn("adelay=1200|1200", f)
        self.assertIn("adelay=5300|5300", f)
        self.assertIn("amix=inputs=2", f)
        self.assertIn(str(Path(self.sim) / a), args)
        self.assertEqual(args[args.index("-t") + 1], "%.2f" % ((9000 + film.TAIL_MS) / 1000))
        self.assertEqual(args[-1], "out.mp4")

    def test_missing_wav_is_skipped_not_fatal(self):
        a = _wav(self.sim, "line_001.wav")
        events = [{"ms": 100, "type": "line", "audio": a}, {"ms": 200, "type": "line", "audio": "audio/gone.wav"},
                  {"ms": 900, "type": "stop"}]
        args = film.mux_cmd("v.webm", events, self.sim, "out.mp4")
        self.assertIn("amix=inputs=1", self._filter(args))
        self.assertNotIn(str(Path(self.sim) / "audio/gone.wav"), args)

    def test_no_voice_gives_a_silent_track(self):
        args = film.mux_cmd("v.webm", [{"ms": 900, "type": "book_end"}], self.sim, "out.mp4")
        self.assertIn("anullsrc", " ".join(args))
        self.assertIn("-shortest", args)

    def test_no_end_event_keeps_the_whole_video(self):
        a = _wav(self.sim, "line_001.wav")
        args = film.mux_cmd("v.webm", [{"ms": 100, "type": "line", "audio": a}], self.sim, "out.mp4")
        self.assertNotIn("-t", args)

    def test_black_loading_head_is_cut_at_page_ready(self):
        # the video starts with the browser context; the world loads for seconds on a black page first
        a = _wav(self.sim, "line_001.wav")
        events = [{"ms": 3100, "type": "ready"}, {"ms": 4000, "type": "narrator", "audio": a},
                  {"ms": 9000, "type": "book_end"}]
        args = film.mux_cmd("v.webm", events, self.sim, "out.mp4")
        start = 3100 + film.READY_MS
        self.assertEqual(args[args.index("-ss") + 1], "%.2f" % (start / 1000))
        self.assertLess(args.index("-ss"), args.index("v.webm"))
        self.assertIn("adelay=%d|%d" % (4000 - start, 4000 - start), self._filter(args))
        self.assertEqual(args[args.index("-t") + 1], "%.2f" % ((9000 + film.TAIL_MS - start) / 1000))


class Concat(unittest.TestCase):
    def test_list_file_in_order(self):
        d = Path(tempfile.mkdtemp())
        args = film.concat_cmd([d / "a.mp4", d / "b.mp4"], d / "film.mp4", d / "list.txt")
        self.assertEqual((d / "list.txt").read_text(), f"file '{d / 'a.mp4'}'\nfile '{d / 'b.mp4'}'\n")
        self.assertEqual(args[-1], str(d / "film.mp4"))


class PageUrl(unittest.TestCase):
    def test_film_flag_on_the_stage_page(self):
        self.assertTrue(film.page_url("runs/x", 9001, 9002).endswith("&film=1"))




class StageWarningsPrinted(unittest.TestCase):
    def test_film_prints_stage_warnings(self):
        import contextlib
        import io
        import json as _json
        import tempfile
        from pathlib import Path as _P
        from unittest import mock
        from make import film as _film
        run = _P(tempfile.mkdtemp())
        (run / "film").mkdir()
        (run / "film" / "stage_warnings.json").write_text(_json.dumps(["stage: no shotplan -> director"]))
        out = _P(tempfile.mkdtemp()) / "f.mp4"

        def rec(run_, part, *a):
            _P(part).write_bytes(b"x")
            return part
        buf = io.StringIO()
        with mock.patch.object(_film, "record_scene", rec), contextlib.redirect_stdout(buf):
            _film.film([run], out)
        self.assertIn("stage warning: stage: no shotplan -> director", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
