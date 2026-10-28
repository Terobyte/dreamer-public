"""Offline contract tests for the build state machine and clock (spec sections 4, 5).
usage: cd h0/dream && python3 -m unittest -q
"""

import json
import os
import time
import unittest

from clock import Clock
from fsm import BuildFSM


def load(path):
    with open(path) as fh:
        return json.load(fh)


HERE = os.path.dirname(os.path.abspath(__file__))
SCENE = load(os.path.join(HERE, "scenes", "start.json"))
OBJECTS = SCENE["objects"]
POOL = {"old_woman", "old_man", "woman", "man", "child", "creature"}
NEXT = {"actors": [{"name": "Grandma", "voice": "old_woman"}],
        "objects": ["rocking chair", "old radio", "quilt", "teapot", "porch swing"]}


def types(events):
    return [e["type"] for e in events]


def good(bridge="clarinet"):
    return {"bridge": bridge, "destination": "grandma's porch", "next_scene": NEXT,
            "hero_next": {"changes": True, "as": "a child", "voice": "child"},
            "messages": [], "facts_update": [], "abort_build": None, "wake_up": None}


def fsm():
    return BuildFSM(OBJECTS, voices=POOL, now=0.0)


def ready_fsm(t0=0.0):
    f = fsm()
    f.start_build(t0, "clarinet", "porch")
    ev = f.tick(t0 + 420)
    assert "ready" in types(ev), ev
    return f


class TouchTest(unittest.TestCase):
    def test_touch_in_building(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        ev = f.touch(30, "clarinet")
        self.assertEqual(types(ev), ["stall"])
        self.assertEqual(ev[0]["build_pct"], 7)
        self.assertTrue(ev[0]["stalled"])
        self.assertEqual(f.state, "building")
        self.assertEqual(f.hint_level(30), 0)
        self.assertEqual(f.hint_level(300), 0)  # clock alone would say L2
        self.assertEqual(types(f.touch(60, "clarinet")), ["touch_ignored"])
        self.assertEqual(types(f.touch(91, "clarinet")), ["stall"])
        self.assertEqual(f.state, "building")

    def test_touch_cooldown_boundary(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        self.assertEqual(types(f.touch(30, "clarinet")), ["stall"])
        self.assertEqual(types(f.touch(90, "clarinet")), ["touch_ignored"])
        self.assertEqual(types(f.touch(90.1, "clarinet")), ["stall"])


class ReadyTest(unittest.TestCase):
    def test_ready_l4_auto_touch(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        self.assertEqual(f.tick(419), [])
        self.assertEqual(f.state, "building")
        self.assertIn("ready", types(f.tick(420)))
        self.assertEqual(f.tick(439), [])
        ev = f.tick(440)
        self.assertEqual(types(ev), ["hint"])
        self.assertEqual(ev[0]["level"], 4)
        self.assertEqual(f.hint_level(441), 4)
        ev = f.tick(460)
        self.assertEqual(types(ev), ["auto_touch", "transition"])
        self.assertEqual(ev[1]["via"], "auto_touch")
        self.assertEqual(ev[1]["bridge"], "clarinet")
        self.assertEqual(f.state, "transition")

        g = ready_fsm()
        ev = g.touch(430, "clarinet")
        self.assertEqual(types(ev), ["transition"])
        self.assertEqual(ev[0]["via"], "touch")
        self.assertIsNone(g.ready_deadline)
        self.assertIsNone(g.l4_at)
        self.assertEqual(g.tick(445), [])
        self.assertEqual(g.tick(500), [])

    def test_ready_level_max(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        f.touch(10, "clarinet")  # frozen at L0
        self.assertEqual(f.hint_level(400), 0)
        f.tick(420)
        self.assertEqual(f.hint_level(421), 3)
        g = BuildFSM(OBJECTS, voices=POOL, now=0.0,
                     params={"ladder": (0, 120, 240, 999)})
        g.start_build(0, "clarinet", "porch")
        g.tick(250)
        g.touch(250, "clarinet")  # frozen at L2, clock at ready says L2 too
        g.tick(420)
        self.assertEqual(g.hint_level(421), 2)


class AbortTest(unittest.TestCase):
    def test_abort_cancels_timers(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        t = f.begin_consult(100)
        ev = f.finish_consult(105, t, dict(good(), bridge=None, destination=None,
                                           next_scene=None, hero_next=None,
                                           abort_build={"reason": "hero is scared"}))
        self.assertIn("deadline_cancelled", types(ev))
        self.assertIn("consult_due", types(ev))
        self.assertEqual(f.state, "idle")
        self.assertEqual(f.idle_since, 105)
        self.assertEqual(f.due(105), "abort")
        self.assertEqual(f.tick(224), [])
        self.assertIn("director_nudge", types(f.tick(225)))

        f.start_build(300, "clarinet", "porch")
        f.tick(720)
        self.assertEqual(f.state, "ready")
        ev = f.abort(725, "changed mind")
        self.assertIn("deadline_cancelled", types(ev))
        self.assertEqual(f.state, "idle")
        self.assertIsNone(f.ready_deadline)
        self.assertNotIn("auto_touch", types(f.tick(770)))

        f.start_build(800, "clarinet", "porch")
        ev = f.abort(810, "again")
        self.assertIn("wake_up", types(ev))
        self.assertEqual([e for e in ev if e["type"] == "wake_up"][0]["reason"], "abort_loop")
        self.assertTrue(f.awake)

        g = fsm()
        self.assertEqual(types(g.abort(5, "nothing")), ["invalid"])


class LockTest(unittest.TestCase):
    def test_locked_target_block(self):
        for st in ("building", "ready"):
            f = ready_fsm() if st == "ready" else fsm()
            if st == "building":
                f.start_build(0, "clarinet", "porch")
            for key, val in (("bridge", "suitcase"), ("destination", "airport"),
                             ("next_scene", NEXT), ("hero_next", {"changes": False})):
                t = f.begin_consult(430)
                ev = f.finish_consult(431, t, {key: val, "messages": [{"to": "Squidward", "note": "hm"}]})
                inv = [e for e in ev if e["type"] == "invalid"]
                self.assertEqual(len(inv), 1, (st, key, ev))
                self.assertIn(key, inv[0]["fields"])
                self.assertEqual(f.state, st)
                self.assertEqual(f.bridge, "clarinet")
                self.assertEqual(f.destination, "porch")


class EpochTest(unittest.TestCase):
    def test_epoch_stale(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        t = f.begin_consult(10)
        f.abort(12, "x")
        ev = f.finish_consult(18, t, {"messages": [{"to": "Squidward", "note": "n"}],
                                      "facts_update": [{"op": "ADD", "fact": "f"}],
                                      "wake_up": "distress"})
        self.assertEqual(types(ev)[0], "consult_stale")
        self.assertIn("pending_wakeup", types(ev))
        self.assertNotIn("wake_up", types(ev))
        self.assertEqual(f.pending_wakeup, {"reason": "distress", "epoch": t["epoch"]})
        self.assertFalse(f.awake)

        t = f.begin_consult(40)  # idle ticket
        f.start_build(41, "clarinet", "porch")
        ev = f.finish_consult(45, t, good("suitcase"))
        self.assertEqual(types(ev)[0], "consult_stale")
        self.assertEqual(f.bridge, "clarinet")
        self.assertNotIn("build", types(ev))

        ev = f.budget_wakeup(50)
        self.assertEqual(types(ev), ["wake_up"])
        self.assertEqual(ev[0]["reason"], "budget")
        self.assertIsNone(f.pending_wakeup)
        self.assertTrue(f.awake)


class NudgeTest(unittest.TestCase):
    def test_nudge_force_events(self):
        f = fsm()
        t = f.begin_consult(110)
        self.assertEqual((t["label"], t["nudged_before"]), ("free", False))
        self.assertIsNone(f.begin_consult(111))  # one call in flight
        f.finish_consult(118, t, dict(good(), bridge=None))
        self.assertEqual(f.tick(119), [])
        ev = f.tick(120)
        self.assertEqual(types(ev), ["director_nudge"])
        self.assertEqual(f.tick(121), [])  # fires once
        self.assertIsNone(f.due(121))  # min_interval 20 s after the 110 call
        self.assertEqual(f.due(130), "nudge")
        t = f.begin_consult(130)
        self.assertEqual((t["label"], t["hint"]), ("nudged", "nudge"))
        ev = f.finish_consult(138, t, dict(good(), bridge=None))
        c = [e for e in ev if e["type"] == "consult"][0]
        self.assertEqual((c["label"], c["t_call"], c["t_applied"]), ("nudged", 130, 138))
        t = f.begin_consult(160)
        self.assertEqual((t["label"], t["nudged_before"]), ("free", True))
        f.finish_consult(165, t, dict(good(), bridge=None))

        t = f.begin_consult(295)
        ev = f.tick(300)
        self.assertEqual(types(ev), ["director_force"])
        self.assertIsNone(f.due(300))  # director still thinking
        f.finish_consult(303, t, dict(good(), bridge=None))  # before 5:00 call: ok
        self.assertEqual(f.due(303), "force")  # does not wait min_interval
        t = f.begin_consult(303)
        self.assertEqual((t["label"], t["hint"]), ("forced", "force"))
        ev = f.finish_consult(310, t, good())
        self.assertIn("build", types(ev))
        self.assertEqual(f.state, "building")


class FailTest(unittest.TestCase):
    def call(self, f, now, decision):
        t = f.begin_consult(now)
        return f.finish_consult(now + 1, t, decision)

    def test_director_fail_streak(self):
        f = fsm()
        for d in (dict(good(), bridge=None), "{broken", good("spaceship")):
            self.assertNotIn("director_fail", types(self.call(f, 50, d)))
        self.assertEqual(f.fail_streak, 0)
        f.tick(300)
        ev = self.call(f, 300, dict(good(), bridge=None))
        self.assertIn("director_fail", types(ev))
        self.assertEqual(f.fail_streak, 1)
        self.call(f, 330, good("spaceship"))
        self.assertEqual(f.fail_streak, 2)
        ev = self.call(f, 360, "{broken")
        self.assertEqual(f.fail_streak, 3)
        w = [e for e in ev if e["type"] == "wake_up"]
        self.assertEqual(w[0]["reason"], "director_stuck")
        self.assertTrue(f.awake)

        g = fsm()
        g.tick(300)
        bad_voice = good()
        bad_voice["next_scene"] = dict(NEXT, actors=[{"name": "Grandma", "voice": "robot"}])
        self.assertIn("director_fail", types(self.call(g, 300, bad_voice)))
        self.assertIn("director_fail", types(self.call(g, 330, None)))
        self.assertEqual(g.fail_streak, 2)
        ev = self.call(g, 360, good())
        self.assertIn("build", types(ev))
        self.assertEqual(g.fail_streak, 0)
        self.assertFalse(g.awake)


class ClockTest(unittest.TestCase):
    def test_clock_speed(self):
        c = Clock(20)
        self.assertAlmostEqual(c.scale(420), 21.0)
        t = time.monotonic()
        c.sleep(1.0)
        self.assertLess(time.monotonic() - t, 0.2)
        f = BuildFSM(OBJECTS, voices=POOL, speed=20, now=0.0)
        f.start_build(0, "clarinet", "porch")
        self.assertEqual(f.tick(20.9), [])
        self.assertIn("ready", types(f.tick(21.0)))
        self.assertIn("hint", types(f.tick(22.0)))  # 20 s / 20
        self.assertIn("transition", types(f.tick(23.0)))  # 40 s / 20

        n = 210
        c = Clock(n)
        f = BuildFSM(OBJECTS, voices=POOL, speed=n, now=c.now())
        t_build = c.now()
        f.start_build(t_build, "clarinet", "porch")
        t_ready = None
        while t_ready is None:
            c.sleep(0.5)
            for e in f.tick(c.now()):
                if e["type"] == "ready":
                    t_ready = e["t"]
        self.assertGreaterEqual(t_ready - t_build, 420 / n)
        self.assertLessEqual(t_ready - t_build, 420 / n + 2)


class PendingWakeupTest(unittest.TestCase):
    def test_pending_carried_and_cleared(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        t = f.begin_consult(1)
        f.abort(2, "x")
        f.finish_consult(3, t, {"wake_up": "distress"})
        self.assertIsNotNone(f.pending_wakeup)
        t2 = f.begin_consult(4)
        self.assertIsNotNone(t2.get("pending_wakeup"))
        self.assertEqual(t2["pending_wakeup"]["reason"], "distress")
        f.finish_consult(5, t2, {"bridge": None})
        self.assertIsNone(f.pending_wakeup)

    def test_budget_invalidates_open_ticket(self):
        f = fsm()
        t = f.begin_consult(1)
        f.budget_wakeup(2)
        ev = f.finish_consult(3, t, good())
        self.assertNotIn("build", types(ev))
        self.assertEqual(f.state, "idle")
        self.assertTrue(f.awake)

    def test_locked_presence_and_wakeup_combo(self):
        for st in ("building", "ready"):
            f = ready_fsm() if st == "ready" else fsm()
            if st == "building":
                f.start_build(0, "clarinet", "porch")
            t = f.begin_consult(430)
            ev = f.finish_consult(431, t, {"bridge": None, "messages": []})
            self.assertIn("invalid", types(ev), (st, ev))
        for st in ("building", "ready"):
            f = ready_fsm() if st == "ready" else fsm()
            if st == "building":
                f.start_build(0, "clarinet", "porch")
            t = f.begin_consult(430)
            ev = f.finish_consult(431, t, {"wake_up": "distress", "bridge": "clarinet"})
            self.assertIn("invalid", types(ev), (st, ev))
            self.assertIn("wake_up", types(ev), (st, ev))


if __name__ == "__main__":
    unittest.main()
