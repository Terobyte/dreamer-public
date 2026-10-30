import tempfile
import unittest
from pathlib import Path

from pipe2.fakes import FakeEngine, FakeSpark, GREEN
from pipe2.room import Ctx, RoomStore
from pipe2.test_floor import skeleton, plan, answer, FakeAssets


class CollisionEngine(FakeEngine):
    def _report(self, scene):
        self.checks.append(scene)
        if len(scene.get('props', [])) >= 2:
            return {'code': 1, 'errors': [{'code': 'PROP_HITS_PROP', 'path': '/props/1', 'a': 'A_box', 'b': 'B_box'}], 'warnings': []}
        return dict(GREEN)


def fragments():
    return {r: {'props': [{'id': r + '_box', 'room': r}]} for r in ('A', 'B')}


def context(engine=None, spark=None):
    root = Path(tempfile.mkdtemp())
    return Ctx(skeleton(), plan(), spark or FakeSpark(), engine or CollisionEngine(),
               FakeAssets(), RoomStore(root), root / 'work', {})


class SeamsTest(unittest.TestCase):
    def test_only_owner_is_fixed_and_unresolved_rolls_back(self):
        from pipe2.seams import repair_seams
        parts = fragments(); ctx = context(spark=FakeSpark({'seam_fix': [answer(parts['B'])] * 3}))
        result = repair_seams(ctx, parts)
        self.assertEqual([c['room'] for c in ctx.spark.calls], ['B'] * 3)
        self.assertEqual(result.rounds, 3)
        self.assertEqual(result.partials, parts)
        self.assertEqual(result.rolled_back, ['B'])

    def test_good_fix_kept(self):
        from pipe2.seams import repair_seams
        ctx = context(spark=FakeSpark({'seam_fix': [answer({'props': []})]}))
        result = repair_seams(ctx, fragments())
        self.assertEqual(result.partials['B']['props'], [])
        self.assertEqual(result.unresolved, {})

    def test_cap_prevents_spark(self):
        from pipe2.seams import repair_seams
        ctx = context(); ctx.spark.ledger.capped = True
        result = repair_seams(ctx, fragments())
        self.assertEqual(ctx.spark.calls, [])
        self.assertEqual(result.rounds, 0)

    def test_skeleton_findings_never_ask_a_room(self):
        from pipe2.seams import repair_seams
        ctx = context(FakeEngine([{'code': 1, 'errors': [{'code': 'ROOMS_OVERLAP', 'path': '/rooms/0'}]}]))
        result = repair_seams(ctx, fragments())
        self.assertEqual(ctx.spark.calls, [])
        self.assertIn('skeleton', result.unresolved)

class FinalShotsTest(unittest.TestCase):
    def test_exit_two_retried_once_then_reported(self):
        from pipe2.floor import Floor
        from pipe2.engine import EngineError, Gated
        from types import SimpleNamespace
        class BrokenShots(FakeEngine):
            def shots(self, dist, size='960x720'):
                self.n_shots += 1
                raise EngineError(2, 'offline')
        engine = BrokenShots(); root = Path(tempfile.mkdtemp())
        floor = Floor(root, root, {'spark': FakeSpark(), 'assets': SimpleNamespace(close=lambda: None)})
        result = floor._final_shots(Gated(engine, 2), root / 'dist', ['A', 'B'])
        self.assertEqual(engine.n_shots, 2)
        self.assertEqual(result['rooms'], {'A': None, 'B': None})
        self.assertEqual(result['error'], 'shots_failed')

    def test_internal_check_builds_share_gate_with_previews(self):
        import threading
        import time
        from concurrent.futures import ThreadPoolExecutor
        from pipe2.engine import Gated
        class Heavy(FakeEngine):
            def build(self, *args):
                with self._lock:
                    self._live_builds += 1
                    self.max_builds = max(self.max_builds, self._live_builds)
                time.sleep(.01)
                with self._lock: self._live_builds -= 1
            def check_full(self, scene, work):
                self.build(scene, work, 'none', None)
                return dict(GREEN)
        inner = Heavy(); engine = Gated(inner, 2)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda n: engine.check_full({}, Path(tempfile.mkdtemp())) if n % 2 else engine.build({}, Path(tempfile.mkdtemp()), 'none', None), range(16)))
        self.assertEqual(inner.max_builds, 2)
