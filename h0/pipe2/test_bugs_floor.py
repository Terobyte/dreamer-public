"""Regression tests for the 2026-10-31 bug hunt."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from pipe2.engine import EngineError
from pipe2.fakes import FakeEngine, FakeSpark
from pipe2.floor import Floor
from pipe2.room import Ctx, RoomPipeline, RoomStore
from pipe2.seams import repair_seams
from pipe2.test_floor import answer, plan, skeleton
from pipe2.test_room import partial
from pipe2.test_seams import context, fragments


class TestFloorBugRegressions(unittest.TestCase):
    def test_B23_exception_after_green_preserves_green_partial(self):
        root = Path(tempfile.mkdtemp())

        class FailingAssets:
            def put(self, *_args):
                raise EngineError(7, "queue failed")

            def wait(self, *_args):
                pass

        part = partial()
        ctx = Ctx(skeleton=skeleton(("A",)), plan=plan(("A",)),
                  spark=FakeSpark({"builder": [answer(part)]}), engine=FakeEngine(),
                  assets=FailingAssets(), store=RoomStore(root), work=root,
                  effort={"builder": "high"})
        floor = Floor(root, root, {"spark": ctx.spark, "engine": ctx.engine,
                                  "assets": SimpleNamespace(close=lambda: None)})

        result = floor._build_rooms(["A"], ctx)["A"]

        self.assertEqual(("green", part), (result.status, result.partial))

    def test_B29_untouched_room_is_not_listed_as_rolled_back(self):
        ctx = context()
        ctx.spark.ledger.capped = True

        result = repair_seams(ctx, fragments())

        self.assertEqual([], result.rolled_back)

    def test_B42_preview_failure_propagates_its_cause(self):
        root = Path(tempfile.mkdtemp())
        ctx = Ctx(skeleton=skeleton(), plan=plan(), spark=FakeSpark(),
                  engine=FakeEngine(), assets=SimpleNamespace(),
                  store=RoomStore(root), work=root, effort={})

        def broken_build(*_args, **_kwargs):
            raise RuntimeError("build failed")

        ctx.engine.build = broken_build
        pipeline = RoomPipeline("A", ctx)
        pipeline.partial = partial()

        with self.assertRaisesRegex(RuntimeError, "build failed"):
            pipeline._preview("layout", "none")


if __name__ == "__main__":
    unittest.main()
