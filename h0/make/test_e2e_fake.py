"""M6 red: `python3 -m make "<prompt>" --fake --run <tmp>` end to end, offline."""
import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import core, play
from .__main__ import main
from .testkit import offline_spark_module

offline_spark_module(globals())

PROMPT = "two strangers meet in a small house"
DREAM = Path(__file__).resolve().parents[1] / "dream"
CAST_FIX = Path(__file__).resolve().parent / "testdata" / "cast"


def _rows(log):
    return [json.loads(l) for l in Path(log).read_text().splitlines() if l.strip()]


def _play_main_log(run_dir):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = play.main([str(run_dir), "--fake"])
    assert rc == 0, buf.getvalue()
    return buf.getvalue().splitlines()[-1].strip()


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rdir = Path(tempfile.mkdtemp()) / "run"

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")))

    def _res(self):
        return core.run_make(self.rdir, PROMPT, fake=True, live=True)

    def test_1_all_stages_ok(self):
        self.assertEqual(main([PROMPT, "--fake", "--run", str(self.rdir)]), 0)
        man = json.loads((self.rdir / "make.json").read_text())["stages"]
        for sid in ("brief", "refs", "world", "cast", "story", "stage", "shotplan"):
            self.assertEqual(man[sid]["status"], "ok", sid)
        self.assertNotIn("check", man)
        cj = json.loads((self.rdir / "cast" / "cast.json").read_text())
        self.assertTrue(cj)
        for who, c in cj.items():
            gp = self.rdir / "cast" / c["glb"]
            self.assertTrue(gp.is_file(), who)
            self.assertGreater(gp.stat().st_size, 12, who)

    def test_2_stage_json_and_objects(self):
        sj = json.loads((self.rdir / "stage" / "stage.json").read_text())
        self.assertEqual(set(sj), {"dist", "places", "cast", "mode", "book", "seed",
                                   "objects", "voices", "narrator_voice", "start", "moves"})
        self.assertIsInstance(sj["dist"], str)
        self.assertIsInstance(sj["places"], str)
        self.assertIsInstance(sj["cast"], str)
        self.assertIn(sj["mode"], ("book", "seed"))
        self.assertIn("book", sj)
        self.assertIn("seed", sj)
        if sj["mode"] == "seed":
            self.assertIsNone(sj["book"])
            self.assertIsInstance(sj["seed"], str)
        else:
            self.assertIsInstance(sj["book"], dict)
            for k in ("dir", "scene", "score"):
                self.assertIsInstance(sj["book"][k], str)
        self.assertTrue(sj["objects"])
        self.assertTrue(all(isinstance(o, str) for o in sj["objects"]))
        self.assertIsInstance(sj["voices"], dict)
        self.assertTrue(all(isinstance(k, str) and isinstance(v, str)
                            for k, v in sj["voices"].items()))
        self.assertTrue(sj["narrator_voice"] is None or isinstance(sj["narrator_voice"], str))
        self.assertIsInstance(sj["start"], dict)
        self.assertLessEqual(set(sj["start"].values()), set(sj["objects"]))
        names = {p["name"] if isinstance(p, dict) else p
                 for p in json.loads((self.rdir / "stage" / "places.json").read_text())
                 .get("places", json.loads((self.rdir / "stage" / "places.json").read_text()))}
        for o in sj["objects"]:
            self.assertIn(o, names)

    def test_3_rerun_runs_nothing(self):
        import functools
        calls = []
        origs = {n: getattr(core, n) for n in
                 ("_run_brief", "_run_refs", "_run_world", "_run_cast", "_run_story", "_run_stage")}

        def wrap(name):
            @functools.wraps(origs[name])
            def inner(ctx):
                calls.append(name)
                return origs[name](ctx)
            return inner

        patches = {n: wrap(n) for n in origs}
        with mock.patch.multiple(core, **patches), \
                mock.patch("subprocess.run", side_effect=AssertionError("subprocess")), \
                mock.patch("subprocess.Popen", side_effect=AssertionError("subprocess")):
            res = self._res()
        self.assertEqual(set(res.values()), {"cached"}, res)
        self.assertEqual(calls, [])

    def test_4_without_fake_reruns_all(self):
        from . import world as _world
        argv = _world.pipe2_argv("task", "run", usd=1.0, effort="medium")
        for flag in ("--cap-usd", "--cap-calls", "--cap-tokens"):
            self.assertIn(flag, argv)
        ran = []

        def mk(name):
            def fn(ctx):
                ran.append(name)
                (ctx.out / "marker.txt").write_text("{}")
                return 0.0
            return fn
        names = ["_run_brief", "_run_refs", "_run_world", "_run_cast", "_run_story", "_run_stage"]
        with mock.patch.multiple(core, **{n: mk(n) for n in names}):
            self.assertEqual(main([PROMPT, "--run", str(self.rdir)]), 0)
        self.assertEqual(sorted(ran), sorted(names))

    def test_5_play_seed_and_book(self):
        run = Path(tempfile.mkdtemp()) / "run2"
        core.run_make(run, PROMPT, fake=True, live=True)
        log = _play_main_log(run)
        self.assertTrue(any(r.get("touch") == "armchair" for r in _rows(log)))
        sj = json.loads((run / "stage" / "stage.json").read_text())
        sj.update(mode="book", book={"dir": str(DREAM / "books" / "jane-eyre"), "scene": "tea",
                                     "score": "story/score.json"})
        (run / "stage" / "stage.json").unlink() if not (run / "stage").is_symlink() else None
        import sys
        sys.path.insert(0, str(DREAM))
        import book
        (run / "story").mkdir(exist_ok=True)
        (run / "story" / "score.json").write_text(json.dumps(book.score_scene(sj["book"]["dir"], "tea")))
        d = Path(tempfile.mkdtemp())
        (d / "stage").mkdir()
        (d / "stage" / "stage.json").write_text(json.dumps(sj))
        for n in ("world", "story"):
            (d / n).symlink_to((run / n).resolve())
        remark = json.loads((Path(play.EXPECT)).read_text())["cases"][2]["narrator"]
        log = _play_main_log(d)
        self.assertTrue(any(r.get("type") == "narrator" and remark in r.get("text", "") for r in _rows(log)))

    def test_5b_seed_reply_matches_fixture(self):
        cases = json.loads(Path(play.EXPECT).read_text())["cases"]
        exp = next(c for c in cases if "[[TOUCH:" in (c.get("line") or ""))
        reply = play._fake_touch_reply()
        self.assertIn(exp["line"], reply)
        self.assertIn(exp["place"], reply)

    def test_6_cast_src_edit_reruns_cast(self):
        run = Path(tempfile.mkdtemp()) / "run3"
        shutil.copytree(CAST_FIX, run / "cast.src")

        def stub(ctx):
            (ctx.out / "marker.txt").write_text("{}")
            return 0.0

        mocks = {"_run_brief": stub, "_run_refs": stub, "_run_world": stub,
                 "_run_story": stub, "_run_stage": stub, "_run_cast": core._run_cast}
        with mock.patch.multiple(core, **mocks):
            res1 = core.run_make(run, PROMPT, fake=False, live=True)
        self.assertEqual(set(res1.values()), {"ran"}, res1)
        with mock.patch.multiple(core, **mocks):
            res2 = core.run_make(run, PROMPT, fake=False, live=True)
        self.assertEqual(set(res2.values()), {"cached"}, res2)
        p = run / "cast.src" / "cast.json"
        c = json.loads(p.read_text())
        c["Jane Eyre"]["height_m"] = 1.6
        p.write_text(json.dumps(c))
        with mock.patch.multiple(core, **mocks):
            res3 = core.run_make(run, PROMPT, fake=False, live=True)
        self.assertEqual(res3.get("cast"), "ran", res3)
        self.assertEqual(res3.get("stage"), "ran", res3)
        pub = json.loads((run / "cast" / "cast.json").read_text())
        self.assertEqual(pub["Jane Eyre"]["height_m"], 1.6)


if __name__ == "__main__":
    unittest.main()
