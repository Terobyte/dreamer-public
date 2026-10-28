"""Red tests for the phase-3 round-10 judge blockers (spec sections 4, 5a, 8).
usage: cd h0/dream && python3 -m unittest test_contract_r10 -q
"""

import unittest

from director import Director, validate_decision
from fsm import BuildFSM
from sim import Sim, _scripted_decisions

OBJECTS = ["clarinet", "lamp", "quilt", "radio", "chair"]
NEXT = {"actors": [{"name": "Grandma", "voice": "old_woman"}],
        "objects": ["a", "b", "c", "d", "e"]}


def _fsm():
    return BuildFSM(OBJECTS, voices={"old_woman"}, actors=["Squidward"])


class LockedConsultKeepsScriptTest(unittest.TestCase):
    def test_locked_consult_does_not_spend_next_bridge(self):
        fsm = BuildFSM(OBJECTS, voices={"old_woman"}, actors=["Squidward"])
        script = [{"bridge": "lamp", "destination": "porch", "next_scene": NEXT}]
        d = Director(fsm, actors=["Squidward"], script=script)
        fsm.start_build(0, "clarinet", "porch")
        d.consult_async(1)
        d.wait()
        self.assertEqual(d._cur, 0)
        self.assertNotIn("invalid", [e["type"] for e in d.completed_events])

    def test_scripted_bridges_follow_their_scene(self):
        decisions = _scripted_decisions("A", 3)
        for prev, nxt in zip(decisions, decisions[1:]):
            self.assertIn(nxt["bridge"], prev["next_scene"]["objects"])


class HumanLineIsNextTest(unittest.TestCase):
    def test_human_line_plays_after_active_one(self):
        s = Sim(profile="A", fake=True, speed=20)
        s.npc_start("active")
        s.npc_start("prepared NPC")
        s.human_say("human")
        s._line_started_at = s.clock.now() - 2
        s._cycle_line()
        self.assertEqual(s.active_line, {"owner": "human", "text": "human"})
        self.assertIsNone(s.prepared_npc)

    def test_human_line_starts_when_nothing_plays(self):
        s = Sim(profile="A", fake=True, speed=20)
        s.human_say("hello")
        s._cycle_line()
        self.assertEqual(s.active_line, {"owner": "human", "text": "hello"})
        self.assertIsNone(s.next_line)


class MessageRecipientTest(unittest.TestCase):
    def test_unknown_recipient_is_invalid(self):
        f = _fsm()
        t = f.begin_consult(0)
        e = f.finish_consult(1, t, {"bridge": None, "messages": [{"to": "Ghost", "note": "x"}]})
        self.assertIn(("invalid", "unknown_recipient"), [(x["type"], x.get("reason")) for x in e])
        self.assertNotIn("message", [x["type"] for x in e])

    def test_known_recipient_is_delivered(self):
        f = _fsm()
        t = f.begin_consult(0)
        e = f.finish_consult(1, t, {"bridge": None, "messages": [{"to": "Squidward", "note": "x"}]})
        self.assertIn("message", [x["type"] for x in e])

    def test_unknown_recipient_does_not_start_build(self):
        f = _fsm()
        t = f.begin_consult(0)
        f.finish_consult(1, t, {"bridge": "lamp", "destination": "x", "next_scene": NEXT,
                                "messages": [{"to": "Ghost", "note": "x"}]})
        self.assertEqual(f.state, "idle")


class NextSceneTypesTest(unittest.TestCase):
    def _finish(self, next_scene):
        f = _fsm()
        t = f.begin_consult(0)
        return f, f.finish_consult(1, t, {"bridge": "lamp", "destination": "x",
                                          "next_scene": next_scene})

    def test_string_objects_are_invalid(self):
        f, e = self._finish({"actors": NEXT["actors"], "objects": "abcde"})
        self.assertIn("invalid", [x["type"] for x in e])
        self.assertEqual(f.state, "idle")

    def test_string_actors_are_invalid(self):
        f, e = self._finish({"actors": "Gr", "objects": NEXT["objects"]})
        self.assertIn("invalid", [x["type"] for x in e])
        self.assertEqual(f.state, "idle")

    def test_valid_next_scene_builds(self):
        f, _ = self._finish(NEXT)
        self.assertEqual(f.state, "building")

    def test_validate_decision_agrees_with_fsm(self):
        ok, errs = validate_decision({"bridge": "lamp", "next_scene": {"actors": NEXT["actors"],
                                      "objects": "abcde"}}, OBJECTS, ["Squidward"], {"old_woman"})
        self.assertEqual((ok, errs), (False, ["next_scene"]))


if __name__ == "__main__":
    unittest.main()
