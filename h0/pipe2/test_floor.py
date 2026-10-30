"""Tests for the floor stage: architect -> parallel room builders. Offline: fake Spark,
fake engine, fake asset queue."""

import json
import tempfile
import threading
import unittest
from pathlib import Path

from pipe2.fakes import FakeEngine, FakeSpark
from pipe2.floor import Floor

GREEN = {"code": 0, "errors": [], "warnings": []}
RED = {"code": 1, "errors": [{"code": "BAD", "path": "/rooms/0"}], "warnings": []}


def room(rid, x0, x1):
    return {"id": rid, "level": "L0", "height": 3.0,
            "shape": [[x0, 0], [x1, 0], [x1, 4], [x0, 4]],
            "floor": "grey", "ceiling": "white",
            "walls": {"material": "white", "thickness": 0.12}}


def skeleton(room_ids=("A", "B")):
    rooms = [room(rid, i * 4, i * 4 + 4) for i, rid in enumerate(room_ids)]
    openings = [{"id": "o%d" % i, "kind": "door", "at": [i * 4 + 4, 2],
                "width": 0.9, "height": 2.1, "sill": 0}
                for i in range(len(room_ids) - 1)]
    return {
        "version": 0, "name": "v2",
        "levels": [{"id": "L0", "y": 0}],
        "rooms": rooms, "openings": openings,
        "stairs": [], "spawn": {"room": room_ids[0], "at": [1, 1], "yaw": 0},
        "style": {"ambient": 1.0},
        "materials": {"white": {"color": "#eeeae0"}, "grey": {"color": "#888888"}},
        "assets": {}, "props": [],
        "lights": [{"kind": "hemi", "pos": [0, 3, 0], "color": "#ffffff", "power": 0.8}],
        "routes": [],
    }


def plan(room_ids=("A", "B")):
    openings = {"o%d" % i: {"owner": room_ids[i]} for i in range(len(room_ids) - 1)}
    return {"rooms": {rid: {"refs": [], "max_points": 2, "cues": ""}
                      for rid in room_ids}, "openings": openings}


def answer(obj):
    return "```json\n%s\n```" % json.dumps(obj)


class FakeAssets:
    def __init__(self):
        self.puts = []
        self.closed = False

    def put(self, room, keys):
        self.puts.append((room, keys))

    def done(self, room):
        return True

    def wait(self, room):
        pass

    def close(self):
        self.closed = True


class FloorCase(unittest.TestCase):
    def setUp(self):
        self.task_dir = Path(tempfile.mkdtemp())
        (self.task_dir / "TASK.md").write_text("a small studio")
        self.run_dir = Path(tempfile.mkdtemp())

    def deps(self, spark, engine, assets=None, ledger=None):
        return {"spark": spark, "engine": engine, "assets": assets or FakeAssets(),
                "ledger": ledger, "warmth": None,
                "effort": {"builder": "high", "fix": "high", "critic_layout": "high",
                           "critic_assets": "high", "architect": "high",
                           "architect_fix": "high"},
                "flags": None}

    def builder_calls(self, spark):
        return [c for c in spark.calls if c["role"] == "builder"]

    def architect_calls(self, spark):
        return [c for c in spark.calls if c["role"] in ("architect", "architect_fix")]


class TestArchitectRedStopsBeforeBuilders(FloorCase):
    def test_three_red_skeletons_stop_the_run(self):
        bad = answer({"skeleton": skeleton(), "plan": plan()})
        spark = FakeSpark({"architect": [bad], "architect_fix": [bad, bad]})
        engine = FakeEngine([RED, RED, RED])
        floor = Floor(self.task_dir, self.run_dir, self.deps(spark, engine))
        result = floor.run()
        self.assertEqual(result.status, "stopped")
        self.assertEqual(len(self.architect_calls(spark)), 3)
        self.assertEqual(self.builder_calls(spark), [])
        report = json.loads((self.run_dir / "report.json").read_text())
        self.assertEqual(report["status"], "stopped")


class TestBadSkeletonShapeTriggersFixRound(FloorCase):
    def test_room_id_with_underscore_forces_a_fix_before_builders_start(self):
        bad_sk = skeleton(("A_x", "B"))
        good_sk = skeleton(("A", "B"))
        bad = answer({"skeleton": bad_sk, "plan": plan(("A_x", "B"))})
        good = answer({"skeleton": good_sk, "plan": plan(("A", "B"))})
        builder_ans = [answer({"props": []}), answer({"props": []})]
        spark = FakeSpark({"architect": [bad], "architect_fix": [good],
                           "builder": builder_ans})
        engine = FakeEngine([GREEN, GREEN, GREEN])
        floor = Floor(self.task_dir, self.run_dir, self.deps(spark, engine))
        result = floor.run()
        self.assertEqual(result.status, "done")
        calls = spark.calls
        roles_in_order = [c["role"] for c in calls]
        self.assertEqual(roles_in_order[0], "architect")
        self.assertIn("architect_fix", roles_in_order)
        first_builder = roles_in_order.index("builder")
        self.assertLess(roles_in_order.index("architect_fix"), first_builder)


class TestOneRoomFailsOthersSucceed(FloorCase):
    def test_exhausted_builder_queue_leaves_one_room_empty(self):
        ids = ("A", "B", "C")
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        empty = answer({"props": []})
        spark = FakeSpark({"architect": [good], "builder": [empty, empty],
                           "critic_layout": [empty, empty], "critic_assets": [empty, empty]})
        engine = FakeEngine([GREEN] * 8)
        floor = Floor(self.task_dir, self.run_dir, self.deps(spark, engine))
        result = floor.run()
        self.assertEqual(result.status, "done")
        statuses = [r.status for r in result.rooms.values()]
        self.assertEqual(sorted(statuses), ["empty", "green", "green"])


class TestSkeletonFindingAfterBuildersDoesNotCallArchitect(FloorCase):
    def test_post_build_skeleton_finding_is_reported_not_sent_back(self):
        ids = ("A",)
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        spark = FakeSpark({"architect": [good], "builder": [answer({"props": []})]})
        final_red = {"code": 1, "errors": [{"code": "STAIRS_BAD", "path": "/stairs/0"}],
                     "warnings": []}
        engine = FakeEngine([GREEN, GREEN, final_red])
        floor = Floor(self.task_dir, self.run_dir, self.deps(spark, engine))
        result = floor.run()
        self.assertEqual(result.status, "done")
        self.assertEqual(len(self.architect_calls(spark)), 1)
        self.assertTrue(any(d.get("code") == "STAIRS_BAD" for d in result.skeleton_defects))


class _BarrierSpark:
    """Wraps a FakeSpark; a `builder` ask waits on a barrier so three rooms only pass it
    if they were really dispatched together, not one after another."""

    def __init__(self, inner, barrier):
        self.inner = inner
        self.barrier = barrier

    def ask(self, role, room, round_no, messages, effort):
        if role == "builder":
            self.barrier.wait(timeout=5)
        return self.inner.ask(role, room, round_no, messages, effort)

    @property
    def calls(self):
        return self.inner.calls


class TestBuildersRunInParallel(FloorCase):
    def test_three_rooms_pass_a_barrier_together(self):
        ids = ("A", "B", "C")
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        empty = answer({"props": []})
        inner = FakeSpark({"architect": [good], "builder": [empty, empty, empty],
                           "critic_layout": [empty, empty, empty],
                           "critic_assets": [empty, empty, empty]})
        barrier = threading.Barrier(len(ids))
        spark = _BarrierSpark(inner, barrier)
        engine = FakeEngine([GREEN] * 10)
        floor = Floor(self.task_dir, self.run_dir, self.deps(spark, engine))
        result = floor.run()
        self.assertEqual(result.status, "done")
        statuses = [r.status for r in result.rooms.values()]
        self.assertEqual(statuses, ["green", "green", "green"])


class _StubLedger:
    def __init__(self, capped):
        self.capped = capped

    def record(self, event):
        pass


class TestCapFlagInReport(FloorCase):
    def test_capped_ledger_is_reflected_in_the_report(self):
        ids = ("A",)
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        spark = FakeSpark({"architect": [good], "builder": [answer({"props": []})]})
        engine = FakeEngine([GREEN, GREEN, GREEN])
        floor = Floor(self.task_dir, self.run_dir,
                      self.deps(spark, engine, ledger=_StubLedger(True)))
        result = floor.run()
        self.assertTrue(result.stopped_by_cap)
        report = json.loads((self.run_dir / "report.json").read_text())
        self.assertTrue(report["stopped_by_cap"])

    def test_uncapped_ledger_is_reflected_in_the_report(self):
        ids = ("A",)
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        spark = FakeSpark({"architect": [good], "builder": [answer({"props": []})]})
        engine = FakeEngine([GREEN, GREEN, GREEN])
        floor = Floor(self.task_dir, self.run_dir,
                      self.deps(spark, engine, ledger=_StubLedger(False)))
        result = floor.run()
        self.assertFalse(result.stopped_by_cap)


from pipe2.floor import skeleton_defects


class TestSkeletonDefectsShape(unittest.TestCase):
    def test_truthy_non_dict_skeleton_is_a_fixable_defect(self):
        self.assertTrue(skeleton_defects(["bad"], {}))
        self.assertTrue(skeleton_defects({}, ["bad"]))
        self.assertTrue(skeleton_defects(None, None))

    def test_opening_owned_outside_its_rooms_is_a_defect(self):
        sk = skeleton(("A", "B", "C"))
        bad_plan = plan(("A", "B", "C"))
        bad_plan["openings"]["o0"] = {"owner": "C"}
        defects = skeleton_defects(sk, bad_plan)
        self.assertIn({"msg": "opening owner is not one of its rooms", "id": "o0"},
                      defects)

    def test_room_without_a_plan_entry_is_a_defect(self):
        sk = {"rooms": [{"id": "A"}], "openings": []}
        self.assertTrue(skeleton_defects(sk, {"rooms": {}, "openings": {}}))


class TestOnOpeningOwnerMayBeEitherSide(unittest.TestCase):
    def test_owner_from_the_second_room_needs_no_fix(self):
        sk = skeleton(("A", "B"))
        sk["openings"] = [{"id": "o0", "kind": "door",
                           "on": {"room": "A", "edge": 1, "t": 0.5}, "width": 0.9}]
        good_plan = plan(("A", "B"))
        good_plan["openings"]["o0"] = {"owner": "B"}
        self.assertEqual([], skeleton_defects(sk, good_plan))


class TestRoomPlanEntryFields(unittest.TestCase):
    def test_entry_without_refs_max_points_and_cues_is_a_defect(self):
        sk = skeleton(("A",))
        sk["openings"] = []
        self.assertTrue(
            skeleton_defects(sk, {"rooms": {"A": {}}, "openings": {}}))


class TestUnhashablePlanValuesAreDefects(unittest.TestCase):
    def test_list_owner_is_a_defect_not_a_crash(self):
        bad_plan = plan(("A", "B"))
        bad_plan["openings"]["o0"] = {"owner": ["A"]}
        self.assertTrue(skeleton_defects(skeleton(("A", "B")), bad_plan))

    def test_list_opening_id_is_a_defect_not_a_crash(self):
        sk = skeleton(("A", "B"))
        sk["openings"] = [{"id": ["o0"], "kind": "door", "at": [4, 2],
                           "width": 0.9}]
        self.assertTrue(skeleton_defects(sk, plan(("A", "B"))))


class TestOpeningOwnerOutsideDoorRoomsForcesFix(FloorCase):
    def test_owner_c_of_an_a_b_door_is_fixed_before_builders_start(self):
        ids = ("A", "B", "C")
        sk = skeleton(ids)
        bad_plan = {"rooms": {rid: {"refs": [], "max_points": 2, "cues": ""}
                              for rid in ids},
                    "openings": {"o0": {"owner": "C"}, "o1": {"owner": "B"}}}
        bad = answer({"skeleton": sk, "plan": bad_plan})
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        empty = answer({"props": []})
        spark = FakeSpark({"architect": [bad], "architect_fix": [good],
                           "builder": [empty, empty, empty],
                           "critic_layout": [empty, empty, empty],
                           "critic_assets": [empty, empty, empty]})
        engine = FakeEngine([GREEN] * 10)
        floor = Floor(self.task_dir, self.run_dir, self.deps(spark, engine))
        result = floor.run()
        self.assertEqual(result.status, "done")
        roles = [c["role"] for c in spark.calls]
        self.assertIn("architect_fix", roles)
        self.assertLess(roles.index("architect_fix"), roles.index("builder"))


class TestOpeningWithoutIdForcesFix(FloorCase):
    def test_opening_without_id_is_fixed_before_builders_start(self):
        sk = skeleton()
        sk["openings"] = [{"kind": "door", "at": [4, 2], "width": 0.9,
                           "height": 2.1, "sill": 0}]
        bad = answer({"skeleton": sk, "plan": plan()})
        good = answer({"skeleton": skeleton(), "plan": plan()})
        spark = FakeSpark({"architect": [bad], "architect_fix": [good],
                           "builder": [answer({"props": []}),
                                       answer({"props": []})]})
        engine = FakeEngine([GREEN] * 6)
        floor = Floor(self.task_dir, self.run_dir, self.deps(spark, engine))
        result = floor.run()
        self.assertEqual(result.status, "done")
        roles = [c["role"] for c in spark.calls]
        self.assertIn("architect_fix", roles)
        self.assertLess(roles.index("architect_fix"), roles.index("builder"))


class TestReportRoomsAndLedgerFields(FloorCase):
    def test_report_lists_room_statuses_timeline_and_spend(self):
        from pipe2.fakes import FakeLedger
        ids = ("A", "B", "C")
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        empty = answer({"props": []})
        spark = FakeSpark({"architect": [good], "builder": [empty, empty],
                           "critic_layout": [empty, empty],
                           "critic_assets": [empty, empty]})
        engine = FakeEngine([GREEN] * 8)
        ledger = FakeLedger()
        ledger.events.append({"kind": "spark", "role": "builder", "room": "A",
                              "round": 0, "cost_usd": 0.5})
        floor = Floor(self.task_dir, self.run_dir,
                      self.deps(spark, engine, ledger=ledger))
        result = floor.run()
        self.assertEqual(result.status, "done")
        report = json.loads((self.run_dir / "report.json").read_text())
        statuses = sorted(v["status"] for v in report["rooms"].values())
        self.assertEqual(statuses, ["empty", "green", "green"])
        self.assertEqual(report["timeline"], ledger.events)
        self.assertAlmostEqual(report["total_usd"], 0.5)


class _FlipOnBuilderSpark:
    """Sets ledger.capped the first time a builder asks, like a real cap hit."""

    def __init__(self, inner, ledger):
        self.inner = inner
        self.ledger = ledger

    def ask(self, role, room, round_no, messages, effort):
        if role == "builder":
            self.ledger.capped = True
        return self.inner.ask(role, room, round_no, messages, effort)

    @property
    def calls(self):
        return self.inner.calls


class TestCapTrippedDuringBuilders(FloorCase):
    def test_cap_set_on_a_builder_call_is_reported(self):
        ids = ("A",)
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        inner = FakeSpark({"architect": [good],
                           "builder": [answer({"props": []})]})
        ledger = _StubLedger(False)
        spark = _FlipOnBuilderSpark(inner, ledger)
        engine = FakeEngine([GREEN, GREEN, GREEN])
        floor = Floor(self.task_dir, self.run_dir,
                      self.deps(spark, engine, ledger=ledger))
        result = floor.run()
        self.assertTrue(result.stopped_by_cap)
        report = json.loads((self.run_dir / "report.json").read_text())
        self.assertTrue(report["stopped_by_cap"])

    def test_no_cap_means_false_in_the_report(self):
        ids = ("A",)
        good = answer({"skeleton": skeleton(ids), "plan": plan(ids)})
        spark = FakeSpark({"architect": [good],
                           "builder": [answer({"props": []})]})
        engine = FakeEngine([GREEN, GREEN, GREEN])
        floor = Floor(self.task_dir, self.run_dir,
                      self.deps(spark, engine, ledger=_StubLedger(False)))
        result = floor.run()
        self.assertFalse(result.stopped_by_cap)
        report = json.loads((self.run_dir / "report.json").read_text())
        self.assertFalse(report["stopped_by_cap"])


class _CapOnArchitectSpark:
    """Trips the cap while the architect is still being asked, then answers nothing."""

    def __init__(self, inner, ledger):
        self.inner = inner
        self.ledger = ledger

    def ask(self, role, room, round_no, messages, effort):
        if role in ("architect", "architect_fix"):
            self.ledger.capped = True
        return self.inner.ask(role, room, round_no, messages, effort)

    @property
    def calls(self):
        return self.inner.calls


class TestCapTrippedDuringArchitect(FloorCase):
    def test_cap_set_by_an_architect_call_is_reported_on_stop(self):
        ledger = _StubLedger(False)
        spark = _CapOnArchitectSpark(FakeSpark({}), ledger)
        engine = FakeEngine([])
        floor = Floor(self.task_dir, self.run_dir,
                      self.deps(spark, engine, ledger=ledger))
        result = floor.run()
        self.assertEqual(result.status, "stopped")
        report = json.loads((self.run_dir / "report.json").read_text())
        self.assertTrue(report["stopped_by_cap"])


if __name__ == "__main__":
    unittest.main()

class TestFinalArchitectFindings(unittest.TestCase):
    def test_newline_room_id_is_invalid(self):
        from pipe2.floor import skeleton_defects
        s = skeleton(('A\n',))
        self.assertTrue(skeleton_defects(s, plan(('A\n',))))

    def test_curved_shared_opening_accepts_neighbour(self):
        from pipe2.floor import skeleton_defects
        for position in ({'t': 0.5}, {'m': 2.3182380450040303}):
            s = skeleton(('A', 'B'))
            s['rooms'][0]['shape'] = [[0, 0, {'bulge': .5}], [4, 0], [4, 4], [0, 4]]
            s['rooms'][1]['shape'] = [[4, 0, {'bulge': -.5}], [0, 0], [0, -4], [4, -4]]
            s['openings'] = [{'id': 'o0', 'kind': 'door', 'on': {'room': 'A', 'edge': 0, **position}, 'width': .9}]
            p = plan(('A', 'B')); p['openings']['o0']['owner'] = 'B'
            self.assertEqual(skeleton_defects(s, p), [])

class TestFloorCompletion(FloorCase):
    def test_final_build_runs_even_after_cap(self):
        from types import SimpleNamespace
        good = answer({'skeleton': skeleton(), 'plan': plan()})
        spark = FakeSpark({'architect': [good], 'builder': [answer({'props': []})] * 2})
        ledger = spark.ledger; ledger.capped = False
        ask = spark.ask
        def cap_after_architect(*args, **kwargs):
            result = ask(*args, **kwargs)
            ledger.capped = True
            return result
        spark.ask = cap_after_architect
        deps = self.deps(spark, FakeEngine(), ledger=ledger)
        result = Floor(self.task_dir, self.run_dir, deps).run()
        self.assertTrue((self.run_dir / 'dist/index.html').exists())
        self.assertTrue(result.stopped_by_cap)

    def test_resume_does_not_ask_architect_or_finished_room(self):
        (self.run_dir / 'skeleton.json').write_text(json.dumps(skeleton()))
        (self.run_dir / 'plan.json').write_text(json.dumps(plan()))
        from pipe2.room import RoomStore, RoomResult
        RoomStore(self.run_dir).finish('A', RoomResult('A', 'green', 3, {'props': []}))
        spark = FakeSpark({'builder': [answer({'props': []})],
                           'critic_layout': [answer({'props': []})], 'critic_assets': [answer({'props': []})]})
        result = Floor(self.task_dir, self.run_dir, self.deps(spark, FakeEngine()), resume=True).run()
        self.assertEqual(self.architect_calls(spark), [])
        self.assertEqual([c['room'] for c in self.builder_calls(spark)], ['B'])
        self.assertTrue((self.run_dir / 'dist/index.html').exists())

    def test_interrupt_stops_new_spark_calls_and_still_builds(self):
        good = answer({'skeleton': skeleton(), 'plan': plan()})
        spark = FakeSpark({'architect': [good]})
        floor = Floor(self.task_dir, self.run_dir, self.deps(spark, FakeEngine()))
        ask = spark.ask
        def interrupt_after_architect(*args, **kwargs):
            result = ask(*args, **kwargs); floor.interrupt(); return result
        spark.ask = interrupt_after_architect
        result = floor.run()
        self.assertEqual(result.status, 'interrupted')
        self.assertEqual(len(spark.calls), 1)
        self.assertTrue((self.run_dir / 'dist/index.html').exists())

class TestReferenceBoundary(FloorCase):
    def test_architect_cannot_send_arbitrary_local_file_to_builder(self):
        outside = Path(tempfile.mkdtemp()) / 'private.png'; outside.write_bytes(b'private marker')
        bad_plan = plan(); bad_plan['rooms']['A']['refs'] = [str(outside)]
        bad = answer({'skeleton': skeleton(), 'plan': bad_plan})
        good = answer({'skeleton': skeleton(), 'plan': plan()})
        spark = FakeSpark({'architect': [bad], 'architect_fix': [good], 'builder': [answer({'props': []})] * 2})
        Floor(self.task_dir, self.run_dir, self.deps(spark, FakeEngine())).run()
        self.assertEqual(len(self.architect_calls(spark)), 2)
        self.assertNotIn('cHJpdmF0ZSBtYXJrZXI=', json.dumps(spark.calls))

    def test_relative_refs_are_resolved_inside_task(self):
        refs = self.task_dir / 'refs'; refs.mkdir(); (refs / 'room.png').write_bytes(b'reference')
        p = plan(); p['rooms']['A']['refs'] = ['room.png']
        spark = FakeSpark({'architect': [answer({'skeleton': skeleton(), 'plan': p})], 'builder': [answer({'props': []})] * 2})
        Floor(self.task_dir, self.run_dir, self.deps(spark, FakeEngine())).run()
        call = next(c for c in self.builder_calls(spark) if c['room'] == 'A')
        self.assertTrue(any(part.get('type') == 'image_url' for part in call['messages'][0]['content']))
