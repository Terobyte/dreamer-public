"""A pipe2 that died before its skeleton (bad argv) leaves world.tmp; resuming it crashed on skeleton.json."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from make import world
from make.test_world import _ctx, _prep_run


class ResumeEmpty(unittest.TestCase):
    def test_no_skeleton_means_fresh_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _prep_run(tmp)
            ctx = _ctx(run, resume=True)
            (ctx.out / "run").mkdir(parents=True)
            (ctx.out / "run" / "events.jsonl").write_text("{}\n")  # pipe2 refuses a dir with a run in it
            calls = []
            world.run_world(ctx, runner=lambda argv, **kw: calls.append(argv) or mock.Mock(returncode=0))
            self.assertNotIn("--resume", calls[0])
            self.assertFalse((ctx.out / "run" / "events.jsonl").exists())

    def test_with_skeleton_resumes(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = _prep_run(tmp)
            ctx = _ctx(run, resume=True)
            (ctx.out / "run").mkdir(parents=True)
            (ctx.out / "run" / "skeleton.json").write_text("{}")
            calls = []
            world.run_world(ctx, runner=lambda argv, **kw: calls.append(argv) or mock.Mock(returncode=0))
            self.assertIn("--resume", calls[0])


if __name__ == "__main__":
    unittest.main()
