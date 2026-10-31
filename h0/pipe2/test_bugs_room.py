"""Regression tests for room resume and critic rollback bugs."""
import json
import tempfile
import unittest
from pathlib import Path

from pipe2.fakes import FakeEngine, FakeSpark
from pipe2.room import Ctx, RoomPipeline, RoomStore
from pipe2.test_room import GREEN, PLAN, RED, answer, partial, skeleton


class RoomBugTests(unittest.TestCase):
    def ctx(self, answers, reports=None):
        self.work = Path(tempfile.mkdtemp())
        self.spark = FakeSpark(answers)
        self.engine = FakeEngine(reports)
        self.store = RoomStore(self.work)
        class Assets:
            def put(self, *_): pass
            def done(self, *_): return False
            def wait(self, *_): pass
        return Ctx(skeleton=skeleton(), plan=PLAN, spark=self.spark,
                   engine=self.engine, assets=Assets(), store=self.store,
                   work=self.work, effort={}, spec="SPEC", schema="SCHEMA")

    def test_B17_capped_room_has_no_done_marker(self):
        # A capped Spark request is returned as an unusable answer; the pipeline
        # currently treats exhaustion as a completed empty room.
        ctx = self.ctx({"builder": []})
        RoomPipeline("A", ctx).run()
        self.assertFalse((self.work / "rooms" / "A" / "done.json").exists(),
                         "a capped, incomplete room must remain resumable")

    def test_B24_resume_from_critic_assets_green_does_not_rerun_critics(self):
        ctx = self.ctx({})
        ctx.store.keep_green("A", "critic_assets", 0, partial(), GREEN, False)
        RoomPipeline("A", ctx).run()
        critic_calls = [call for call in self.spark.calls
                        if call["role"] in ("critic_layout", "critic_assets")]
        self.assertEqual([], critic_calls,
                         "a critic_assets green checkpoint already completed both critics")

    def test_B28_accepted_assets_clears_rollback_and_keeps_rejection_findings(self):
        candidate = partial()
        ctx = self.ctx({"builder": [answer(candidate)],
                        "critic_layout": [answer(candidate)],
                        "critic_assets": [answer(candidate)]}, reports=[GREEN, RED, GREEN])
        result = RoomPipeline("A", ctx).run()
        self.assertEqual("green", result.status,
                         "an accepted critic_assets revision clears the earlier rollback")
        events = ctx.spark.ledger.events
        self.assertTrue(any("PROP_OUT_OF_ROOM" in json.dumps(event) for event in events),
                        "the rejected critic_layout findings must be recorded")
