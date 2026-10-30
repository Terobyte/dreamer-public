import copy
import tempfile
import unittest
from pathlib import Path

from pipe2.fakes import FakeEngine, GREEN
from pipe2.test_floor import skeleton, plan
from pipe2.test_seams import CollisionEngine, fragments


class DegradeTest(unittest.TestCase):
    def test_collision_removed_with_dependents_and_bounded(self):
        from pipe2.degrade import degrade
        parts = fragments()
        parts['B']['props'] += [{'id': 'B_top', 'room': 'B', 'mount': {'top_of': 'B_box'}},
                                {'id': 'B_face', 'room': 'B', 'face': 'B_top'}]
        engine = CollisionEngine()
        scene, removed = degrade(engine, Path(tempfile.mkdtemp()), skeleton(), parts, plan())
        self.assertEqual([p['id'] for p in scene['props']], ['A_box'])
        self.assertEqual({r.get('id') for r in removed}, {'B_box', 'B_top', 'B_face'})
        self.assertLessEqual(len(engine.checks), 8)

    def test_warning_does_not_remove_anything(self):
        from pipe2.degrade import degrade
        report = {'code': 0, 'errors': [], 'warnings': [{'code': 'POINT_LIGHT_HIGH'}]}
        scene, removed = degrade(FakeEngine([report]), Path(tempfile.mkdtemp()), skeleton(), fragments(), plan())
        self.assertEqual(removed, [])
        self.assertEqual(len(scene['props']), 2)

    def test_global_defect_removes_rooms_in_reverse_order(self):
        from pipe2.degrade import degrade
        class BothBlock(FakeEngine):
            def _report(self, scene):
                if scene.get('props'):
                    return {'code': 0, 'errors': [], 'warnings': [{'code': 'NAV_ROOM_CUT', 'path': '/rooms/0'}]}
                return dict(GREEN)
        scene, removed = degrade(BothBlock(), Path(tempfile.mkdtemp()), skeleton(), fragments(), plan())
        self.assertEqual(scene['props'], [])
        self.assertEqual([r['room'] for r in removed], ['B', 'A'])

    def test_degrade_always_builds(self):
        from pipe2.degrade import degrade
        from pipe2.engine import Engine, green
        from pipe2.seams import repair_seams
        from pipe2.room import Ctx, RoomStore
        from pipe2.fakes import FakeSpark
        from pipe2.test_floor import FakeAssets, answer
        from pipe2.test_blame import skeleton as nav_skeleton, PLAN, box, BARRICADE
        root = Path(tempfile.mkdtemp())
        engine = Engine(Path(__file__).parents[2] / 'engine', shots=False)
        sk = nav_skeleton()
        parts = {'A': {'props': [box('A_block', *BARRICADE)]},
                 'C': {'props': [box('C_table', 'C', [6, 5], .8, .8)]}}
        spark = FakeSpark({'seam_fix': [answer(parts['A'])] * 3})
        ctx = Ctx(sk, PLAN, spark, engine, FakeAssets(), RoomStore(root), root / 'work', {})
        seam = repair_seams(ctx, parts)
        self.assertEqual(seam.rounds, 3)
        scene, removed = degrade(engine, root / 'work', sk, seam.partials, PLAN)
        self.assertTrue(removed)
        self.assertTrue(green(engine.check_full(scene, root / 'work')))
        engine.build(scene, root / 'dist', 'none', None)
        self.assertTrue((root / 'dist/index.html').exists())
        # Two independent obstructions: removing either room alone leaves the
        # common route broken, so blame is global and both must be degraded.
        sk2 = skeleton(); sk2['assets'] = {'p_box': {'kind': 'object', 'prompt': 'box'}}
        sk2['spawn']['at'] = [1, 2]
        sk2['routes'] = [{'id': 'end', 'path': ['spawn', 'o0', {'room': 'B', 'at': [7, 2]}]}]
        parts2 = {r: {'props': [box(r + '_block', r, [x, 2], .8, 3.7)]}
                  for r, x in [('A', 2.5), ('B', 5.5)]}
        scene2, removed2 = degrade(engine, root / 'work', sk2, parts2, plan())
        self.assertTrue(green(engine.check_full(scene2, root / 'work')))
        self.assertTrue(removed2)
        engine.build(scene2, root / 'dist2', 'none', None)
        self.assertTrue((root / 'dist2/index.html').exists())

    def test_dependents_in_other_rooms_are_removed_too(self):
        from pipe2.degrade import degrade
        parts = fragments()
        parts['A']['props'].append({'id': 'A_look', 'room': 'A', 'face': 'B_box'})
        class ByTarget(FakeEngine):
            def _report(self, scene):
                targets = scene.get('props', [])
                index = next((i for i, p in enumerate(targets) if p['id'] == 'B_box'), None)
                if index is not None:
                    return {'code': 1, 'errors': [{'code': 'BAD_OBJECT', 'path': '/props/%d' % index}], 'warnings': []}
                return dict(GREEN)
        scene, removed = degrade(ByTarget(), Path(tempfile.mkdtemp()), skeleton(), parts, plan())
        self.assertEqual([p['id'] for p in scene['props']], ['A_box'])
        self.assertEqual({r['id'] for r in removed}, {'B_box', 'A_look'})
