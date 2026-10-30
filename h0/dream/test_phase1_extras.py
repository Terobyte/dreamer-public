"""Phase 1.4b contract (spec 7.2 row 1.4b): the director may send `events`,
`goals` and `hero_reason` for the next scene; a broken block is dropped and
logged `invalid`, the bridge and `next_scene` stand, `fail_streak` does not grow.
usage: cd h0/dream && python3 -m unittest test_phase1_extras -q
"""

import json
import os
import tempfile
import unittest
from unittest import mock

import llm
import sim as sim_mod
from director import Director
from fake import FakeTransport
from fsm import BuildFSM, clean_extras
from sim import Sim

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "scenes", "start.json"), encoding="utf-8") as _f:
    OBJECTS = json.load(_f)["objects"]
POOL = {"old_woman", "old_man", "woman", "man", "child", "creature"}
HERO = "Max"

NEXT_ACTORS = [{"name": "Grandma", "voice": "old_woman", "persona": "waits with tea"}]
NEXT_OBJECTS = ["rocking chair", "old radio", "quilt", "teapot", "porch swing"]

GOOD_EVENTS = [
    {"t": 0, "what": "the kettle starts to whistle", "who": "all", "kind": "world"},
    {"t": 60, "what": "the radio loses the station", "who": ["Grandma"], "kind": "world"},
    {"t": 120, "what": "your pocket feels empty", "who": [HERO], "kind": "world"},
]
GOOD_GOALS = [{"actor": "Grandma", "goal": "Max says why he came back",
               "done_when": {"speaker": HERO, "any": ["came", "back"]},
               "judge": False}]


def next_scene(**kw):
    ns = {"actors": [dict(a) for a in NEXT_ACTORS], "objects": list(NEXT_OBJECTS)}
    ns.update(kw)
    return ns


def decision(**ns_kw):
    return {"bridge": "clarinet", "destination": "grandma's porch",
            "next_scene": next_scene(**ns_kw), "hero_next": {"changes": False},
            "messages": [], "facts_update": [], "abort_build": None, "wake_up": None}


class CleanExtrasTest(unittest.TestCase):
    """Each broken block gives one `invalid` descriptor and is removed."""

    def _bad(self, **ns_kw):
        d = decision(**ns_kw)
        desc = clean_extras(d, HERO)
        self.assertIsNotNone(desc, d)
        self.assertTrue(desc["reason"])
        # the bridge and the rest of next_scene survive
        self.assertEqual(d["bridge"], "clarinet")
        self.assertEqual(d["next_scene"]["objects"], NEXT_OBJECTS)
        return desc, d

    def test_good_extras_pass_untouched(self):
        d = decision(events=GOOD_EVENTS, goals=GOOD_GOALS, hero_reason="you came for the box")
        self.assertIsNone(clean_extras(d, HERO))
        self.assertEqual(d["next_scene"]["events"], GOOD_EVENTS)
        self.assertEqual(d["next_scene"]["goals"], GOOD_GOALS)

    def test_event_too_late(self):
        late = [dict(e) for e in GOOD_EVENTS]
        late[2]["t"] = 601
        desc, d = self._bad(events=late)
        self.assertEqual(desc["fields"], ["events"])
        self.assertNotIn("events", d["next_scene"])

    def test_two_events_is_too_few(self):
        desc, d = self._bad(events=GOOD_EVENTS[:2])
        self.assertEqual(desc["fields"], ["events"])
        self.assertNotIn("events", d["next_scene"])

    def test_six_events_is_too_many(self):
        many = [dict(e, t=10 * i) for i, e in enumerate(GOOD_EVENTS * 2)]
        desc, d = self._bad(events=many)
        self.assertEqual(desc["fields"], ["events"])
        self.assertNotIn("events", d["next_scene"])

    def test_event_who_outside_the_cast(self):
        bad = [dict(e) for e in GOOD_EVENTS]
        bad[1]["who"] = ["Dan"]
        desc, d = self._bad(events=bad)
        self.assertEqual(desc["fields"], ["events"])
        self.assertNotIn("events", d["next_scene"])

    def test_goal_actor_outside_the_cast(self):
        desc, d = self._bad(goals=[dict(GOOD_GOALS[0], actor="Dan")])
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_three_goals_is_too_many(self):
        """The schema asks for 0 to 2 goals; a longer list is a broken block."""
        many = [dict(GOOD_GOALS[0], goal="g%d" % i) for i in range(3)]
        desc, d = self._bad(goals=many)
        self.assertEqual(desc["fields"], ["goals"])
        self.assertEqual(desc["reason"], "bad_size")
        self.assertNotIn("goals", d["next_scene"])

    def test_done_when_speaker_outside_the_cast(self):
        """A speaker who is not in the next scene can never say the words, so the
        goal would stay open all scene and block every goal after it."""
        bad = dict(GOOD_GOALS[0],
                   done_when={"speaker": "Dan", "any": ["came", "back"]})
        desc, d = self._bad(goals=[bad])
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_not_after_speaker_outside_the_cast(self):
        bad = dict(GOOD_GOALS[0],
                   done_when={"speaker": HERO, "any": ["came"],
                              "not_after": {"speaker": "Dan", "any": ["came"]}})
        desc, d = self._bad(goals=[bad])
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_two_goals_and_a_hero_speaker_are_fine(self):
        pair = [GOOD_GOALS[0], dict(GOOD_GOALS[0], goal="Max asks for tea",
                                    done_when={"speaker": HERO, "any": ["tea"],
                                               "not_after": {"speaker": "Grandma",
                                                             "any": ["tea"]}})]
        d = decision(goals=pair)
        self.assertIsNone(clean_extras(d, HERO))
        self.assertEqual(d["next_scene"]["goals"], pair)

    def test_goals_bad_type(self):
        desc, d = self._bad(goals="be nice")
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_unhashable_actor_is_invalid_not_crash(self):
        desc, d = self._bad(goals=[{"actor": [], "goal": "x"}])
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_unhashable_speaker_is_invalid_not_crash(self):
        bad = dict(GOOD_GOALS[0], done_when={"speaker": [], "any": ["came"]})
        desc, d = self._bad(goals=[bad])
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_string_judge_is_invalid(self):
        bad = dict(GOOD_GOALS[0], judge="false")
        desc, d = self._bad(goals=[bad])
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_non_world_event_kind_is_invalid(self):
        bad = [dict(e, kind="door") for e in GOOD_EVENTS]
        desc, d = self._bad(events=bad)
        self.assertEqual(desc["fields"], ["events"])
        self.assertNotIn("events", d["next_scene"])

    def test_good_events_survive_bad_goals(self):
        d = decision(events=GOOD_EVENTS, goals=[{"actor": "Dan", "goal": "x"}])
        desc = clean_extras(d, HERO)
        self.assertEqual(desc["fields"], ["goals"])
        self.assertEqual(d["next_scene"]["events"], GOOD_EVENTS)


class DirectorExtrasTest(unittest.TestCase):
    """A broken `goals` block must not cost the dream its bridge (spec 1.4b)."""

    def _director(self, reply):
        fsm = BuildFSM(OBJECTS, voices=POOL, now=0.0, hero=HERO)
        transport = FakeTransport([json.dumps(reply)])

        def call(role, system, messages, max_tokens=300, **kw):
            return llm.call(role, system, messages, max_tokens=max_tokens,
                            fake=True, _transport=transport)

        self.enterContext(mock.patch("director.llm_call", call))
        return Director(fsm, delay=0.0, fake=False), fsm

    def test_bad_goals_keep_bridge(self):
        d, fsm = self._director(decision(goals=[{"actor": "Dan", "goal": "x"}]))
        d.consult_async(0.0)
        d.wait()
        events = d.drain_events()
        bad = [e for e in events if e["type"] == "invalid"]
        self.assertEqual([e["fields"] for e in bad], [["goals"]])
        self.assertTrue(bad[0]["reason"])
        self.assertEqual(fsm.state, "building")
        self.assertEqual(fsm.bridge, "clarinet")
        self.assertEqual(fsm.next_scene["objects"], NEXT_OBJECTS)
        self.assertNotIn("goals", fsm.next_scene)
        self.assertEqual(fsm.fail_streak, 0)
        self.assertEqual([e["verdict"] for e in events if e["type"] == "consult"], ["build"])

    def test_director_schema_asks_for_the_new_fields(self):
        import director as director_mod
        for field in ("events", "goals", "hero_reason"):
            self.assertIn(field, director_mod.DIRECTOR_SCHEMA)


class TransitionExtrasTest(unittest.TestCase):
    """Correct extras reach the next scene: a `schedule` row with them and
    `hero_reason` delivered as the event `t=0, who=[hero]`."""

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        sim_mod.use_scene("roof3")
        self.addCleanup(sim_mod.use_scene, "start")

    def rows(self):
        with open(os.path.join(self.root, "log.jsonl"), encoding="utf-8") as f:
            return [json.loads(l) for l in f]

    def test_good_extras_reach_next_scene(self):
        self.root = tempfile.mkdtemp()
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root)
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        self.assertEqual(sim.fsm.hero, sim.hero)
        d = decision(events=GOOD_EVENTS, goals=GOOD_GOALS,
                     hero_reason="you came back for the box")
        self.assertIsNone(clean_extras(d, sim.hero))
        ns = d["next_scene"]
        sim.fsm.bridge, sim.fsm.destination = "clarinet", d["destination"]
        sim.fsm.next_scene, sim.fsm.hero_next = ns, d["hero_next"]
        sim._apply_transition()

        self.assertEqual(sim.scene["goals"], GOOD_GOALS)
        sched = [r for r in self.rows() if r["type"] == "schedule"][-1]
        whats = [e["what"] for e in sched["events"]]
        self.assertEqual(whats[0], "you came back for the box")
        self.assertEqual(sched["events"][0]["who"], [sim.hero])
        self.assertEqual(sched["events"][0]["t"], 0)
        for e in GOOD_EVENTS:
            self.assertIn(e["what"], whats)

        sim._fire_due_events()
        fired = [r for r in self.rows() if r["type"] == "event"]
        hero_ev = [r for r in fired if r["what"] == "you came back for the box"]
        self.assertEqual([r["who"] for r in hero_ev], [[sim.hero]])
        self.assertIn("you came back for the box", sim._hero_world)


class JudgeAndDeadGoalTest(unittest.TestCase):
    """F4/F5: schema permits judge:true; dead code-goals are invalid."""

    def test_schema_permits_judge_true(self):
        import director as director_mod
        self.assertIn('"judge": true', director_mod.DIRECTOR_SCHEMA)

    def test_done_when_null_nonjudge_is_invalid(self):
        d = {"next_scene": {"actors": [{"name": "Grandma"}], "objects": NEXT_OBJECTS,
                            "goals": [{"actor": "Grandma", "goal": "x",
                                       "judge": False, "done_when": None}]}}
        desc = clean_extras(d, HERO)
        self.assertIsNotNone(desc)
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_done_when_empty_any_is_invalid(self):
        d = {"next_scene": {"actors": [{"name": "Grandma"}], "objects": NEXT_OBJECTS,
                            "goals": [{"actor": "Grandma", "goal": "x",
                                       "judge": False,
                                       "done_when": {"speaker": HERO, "any": []}}]}}
        desc = clean_extras(d, HERO)
        self.assertIsNotNone(desc)
        self.assertEqual(desc["fields"], ["goals"])
        self.assertNotIn("goals", d["next_scene"])

    def test_judge_true_without_done_when_is_fine(self):
        d = {"next_scene": {"actors": [{"name": "Grandma"}], "objects": NEXT_OBJECTS,
                            "goals": [{"actor": "Grandma", "goal": "x",
                                       "judge": True}]}}
        self.assertIsNone(clean_extras(d, HERO))


if __name__ == "__main__":
    unittest.main()
