"""M3: stage `world` - TASK.md adapter, pipe2 argv, --resume, --fake fixture."""
import json
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import core, world

DATA = Path(__file__).resolve().parent / "testdata"
BRIEF = {"title": "Jane Eyre tea", "mode": "book", "book": None, "style": "warm gouache, flat painted colours",
         "places": [
             {"id": "kitchen", "type": "room", "size_m": [4, 3], "level": 0, "next_to": ["hall"],
              "query": "k", "provider_hint": "commons", "fandom_wiki": None},
             {"id": "hall", "type": "room", "size_m": [5, 4], "level": 0, "next_to": ["kitchen"],
              "query": "h", "provider_hint": "commons", "fandom_wiki": None},
             {"id": "attic", "type": "room", "size_m": [6, 5], "level": 1, "next_to": [],
              "query": None, "provider_hint": "commons", "fandom_wiki": None}],
         "cast": [{"who": "Rochester", "sex": "male", "age": "adult", "look": "dark", "voice": "man", "query": "m"}],
         "scene": {"where": "hall", "who": ["Rochester"], "want": "tea"}}


class NoNet(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network"))
        p.start()
        self.addCleanup(p.stop)


class TaskSnapshot(NoNet):
    def test_task_md_snapshot(self):
        self.assertEqual(world.build_task_md(BRIEF), (DATA / "expect_task.md").read_text())

    def test_no_names(self):
        md = world.build_task_md(BRIEF)
        for name in ("Jane", "Eyre", "Rochester"):
            self.assertNotIn(name, md)

    def test_yard_asks_for_an_open_room_not_an_interior(self):
        # Twelve Oaks: a lawn written as a 30 m closed room gave a bare 25 m wall over the house
        brief = {**BRIEF, "places": [*BRIEF["places"][:2],
                 {"id": "street", "type": "yard", "size_m": [30, 10], "level": 0, "next_to": ["hall"],
                  "query": "s", "provider_hint": "commons", "fandom_wiki": None}]}
        md = world.build_task_md(brief)
        self.assertNotIn("whole interior", md)
        for word in ("`open: true`", "`outdoor`", "`facade`", "`roof`"):
            self.assertIn(word, md)


class Argv(NoNet):
    def test_all_caps_and_effort(self):
        a = world.pipe2_argv(Path("t"), Path("r"), usd=7.0, effort="builder=medium")
        self.assertEqual(a[1:4], ["-m", "pipe2", "run"])
        for flag in ("--cap-usd", "--cap-calls", "--cap-tokens"):
            self.assertIn(flag, a)
        self.assertEqual(a[a.index("--cap-usd") + 1], "7.0")
        self.assertEqual(a[a.index("--effort") + 1], "builder=medium")
        self.assertNotIn("--resume", a)
        self.assertEqual(a[a.index("--run-dir") + 1], "r")

    def test_default_caps_when_no_budget(self):
        a = world.pipe2_argv(Path("t"), Path("r"))
        for flag in ("--cap-usd", "--cap-calls", "--cap-tokens"):
            self.assertIn(flag, a)
        self.assertNotIn("--effort", a)

    def test_resume_flag(self):
        self.assertIn("--resume", world.pipe2_argv(Path("t"), Path("r"), resume=True))


def _prep_run(tmp):
    run = Path(tmp) / "run"
    (run / "brief").mkdir(parents=True)
    (run / "brief" / "brief.json").write_text(json.dumps(BRIEF))
    (run / "refs").mkdir()
    (run / "refs" / "cues.md").write_text("## hall\n\nbig fireplace\n")
    return run


def _ctx(run, **kw):
    out = run / "world.tmp"
    out.mkdir(exist_ok=True)
    d = dict(run_dir=run, out=out, params={}, resume=False, budget_usd=None, opts={})
    d.update(kw)
    return core.Ctx(**d)


class RunWorld(NoNet):
    def test_calls_pipe2_with_caps(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _prep_run(tmp)
            ctx = _ctx(run, budget_usd=7.0, opts={"effort": "builder=medium"})
            calls = []
            world.run_world(ctx, runner=lambda argv, **kw: calls.append(argv) or mock.Mock(returncode=0))
            self.assertEqual(len(calls), 1)
            self.assertIn("--cap-tokens", calls[0])
            self.assertEqual(calls[0][calls[0].index("--cap-usd") + 1], "7.0")
            self.assertTrue((ctx.out / "task" / "TASK.md").is_file())
            self.assertEqual((ctx.out / "task" / "cues.md").read_text(), "## hall\n\nbig fireplace\n")

    def test_failure_raises_and_resume_passes_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _prep_run(tmp)
            with self.assertRaises(Exception):
                world.run_world(_ctx(run), runner=lambda argv, **kw: mock.Mock(returncode=3))
            calls = []
            world.run_world(_ctx(run, resume=True),
                            runner=lambda argv, **kw: calls.append(argv) or mock.Mock(returncode=0))
            self.assertIn("--resume", calls[0])

    def test_fake_copies_fixture_no_pipe2(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _prep_run(tmp)
            ctx = _ctx(run, params={"fake": True})
            world.run_world(ctx, runner=lambda *a, **k: self.fail("pipe2 must not run"))
            self.assertTrue((ctx.out / "run" / "scene.json").is_file())
            self.assertTrue((ctx.out / "run" / "events.jsonl").is_file())
            self.assertTrue((ctx.out / "task" / "TASK.md").is_file())

    def test_failed_world_keeps_tmp_and_resumes_via_make(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _prep_run(tmp)
            seen = []

            def runner(argv, **kw):
                seen.append(argv)
                return mock.Mock(returncode=1 if len(seen) == 1 else 0)
            st = core.Stage("world", (), 1, lambda c: world.run_world(c, runner=runner), ("fake", "effort", "cap"))
            out = core.run_make(run, "p", stages={"world": st}, only="world")
            self.assertEqual(out["world"], "failed")
            self.assertTrue((run / "world.tmp").is_dir())
            out = core.run_make(run, "p", stages={"world": st}, only="world")
            self.assertEqual(out["world"], "ran")
            self.assertIn("--resume", seen[1])
            self.assertNotIn("--resume", seen[0])


if __name__ == "__main__":
    unittest.main()
