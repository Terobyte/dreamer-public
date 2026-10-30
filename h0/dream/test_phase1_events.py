"""Phase 1.3 contract (spec 7.2 row 1.3, debt D1/D3): the schedule of events is
code's, not the model's. Events fire on every loop step in full silence, a dead
scene's schedule never fires, "Just now" is a queue per recipient, and the hero's
reason to be here arrives as the t=0 event of any scene.
usage: cd h0/dream && python3 -m unittest test_phase1_events -q
"""

import json
import os
import tempfile
import unittest
from unittest import mock

import sim as sim_mod
from sim import Sim
from test_phase1_util import manual_clock, pump


def rows(root):
    with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class StubDialogue:
    """Scripted lines; records the `events` queue each actor was handed."""

    def __init__(self, hero, text=None):
        self.hero = hero
        self.event_sink = None
        self.text = text
        self.seen_events = []
        self.seen_world = []
        self.n = 0

    def _line(self, who, role):
        self.n += 1
        if self.text is None:
            return None
        return {"who": who, "role": role, "text": self.text % self.n,
                "remarks": [], "raw": self.text % self.n}

    def hero_line(self, world, transcript, world_events=()):
        self.seen_world.append(list(world_events))
        return self._line(self.hero, "hero")

    def actor_line(self, actor, world, transcript, state, notes=(), events=(),
                   persona=""):
        self.seen_events.append((actor, list(events)))
        return self._line(actor, "actor")


class EventsTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.addCleanup(sim_mod.use_scene, "start")

    def _sim(self, scene, dialogue=None, speed=8.0):
        sim_mod.use_scene(scene)
        self.root = tempfile.mkdtemp()
        sim = Sim(profile="A", fake=True, speed=speed, outdir=self.root,
                  dialogue=dialogue)
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        manual_clock(self, sim)
        sim.scene_start = 0.0
        return sim

    def _silent(self, sim, t_sim):
        """Advance to t_sim simulated seconds with nobody ever speaking: only the
        loop step runs, so an event that needs a free tick would never fire."""
        self.now = t_sim / sim.speed
        sim._tick()

    def _schedule(self):
        sched = [r for r in rows(self.root) if r["type"] == "schedule"]
        self.assertEqual(len(sched), 1, "one schedule row per scene start")
        return sched[0]["events"]

    def _fired(self):
        return [r["what"] for r in rows(self.root) if r["type"] == "event"]

    # --- the schedule runs on the clock, in silence -------------------------
    def test_events_fire_in_silence(self):
        sim = self._sim("roof")
        planned = self._schedule()
        self.assertTrue(planned, "roof.json carries the scene's starting events")
        # the hero's reason to be here is the first event, inserted by use_scene
        self.assertEqual(planned[0]["t"], 0)
        self.assertEqual(planned[0]["who"], [sim.hero])
        late = max(planned, key=lambda e: e["t"])
        self.assertGreater(late["t"], 0, "not every event is at t=0")

        self._silent(sim, 0.0)
        due = [e["what"] for e in planned if e["t"] == 0]
        self.assertEqual(self._fired(), due, "t=0 fires on the first loop step")

        self._silent(sim, late["t"] - 1)
        self.assertNotIn(late["what"], self._fired(), "not before its second")
        self._silent(sim, late["t"])
        self.assertEqual(self._fired(), [e["what"] for e in planned],
                         "every planned event fired, in order, with no line spoken")
        row = [r for r in rows(self.root) if r["type"] == "event"][-1]
        self.assertEqual(row["kind"], late["kind"])
        self.assertEqual(row["who"], [sim.hero] + list(sim.actors)
                         if late["who"] == "all" else late["who"])

    def test_old_scene_events_dead(self):
        sim = self._sim("roof")
        late = max(self._schedule(), key=lambda e: e["t"])
        self._silent(sim, 0.0)
        sim._apply_transition()
        self.now += 1.0
        sim.scene_start = self.now
        self._silent(sim, late["t"] * 2)
        self.assertNotIn(late["what"], self._fired(),
                         "the previous scene's schedule is dead after transition")

    # --- the "Just now" queue belongs to its recipient ---------------------
    def test_pending_dropped_for_absent_actor(self):
        dlg = StubDialogue("Max", "[flat] line %d.")
        sim = self._sim("roof", dlg)
        sim._pending.setdefault("Dan", []).append("a ghost note for Dan")
        sim.fsm.next_scene = {"actors": [{"name": "Visitor", "voice": "man"}],
                              "objects": ["item%d" % i for i in range(5)]}
        sim.fsm.hero_next = {"changes": False}
        sim.fsm.destination = "a flooded car park"
        sim._apply_transition()
        self.assertEqual(sim.actors, ["Visitor"])
        self.assertNotIn("Dan", sim._pending)
        for queue in list(sim._pending.values()) + [sim._hero_world]:
            self.assertNotIn("a ghost note for Dan", queue)
        self.now = sim.scene_start
        pump(sim, 12)
        for actor, events in dlg.seen_events:
            self.assertNotIn("a ghost note for Dan", events,
                             "a queue for an absent actor reaches nobody")

    # --- 7.4: the bench counts the schedule it promised vs what fired -------
    def test_score_counts_events(self):
        sim = self._sim("roof")
        planned = self._schedule()
        self._silent(sim, 0.0)
        import bank
        m = bank.score(rows(self.root))
        # §7.4: planned is due by t_sim, so at t=0 only the two t=0 entries count
        self.assertEqual(m["events_planned"], 2)
        self.assertEqual(m["events_fired"], 2,
                         "both t=0 events fired on the first loop step")
        # +1: past the last event's second, clear of the sub-tick skew between
        # scene_start and the schedule row's own logged timestamp (both are
        # separate clock reads, spec 7.4 bounds by the row seen, not the exact tick)
        self._silent(sim, max(e["t"] for e in planned) + 1)
        m = bank.score(rows(self.root))
        self.assertEqual(m["events_planned"], len(planned))
        self.assertEqual(m["events_fired"], len(planned))
        self.assertEqual(bank.score([])["events_planned"], 0)


    # --- D1: every scene tells the hero why he is here ---------------------
    def test_situation_hero_as_event_any_scene(self):
        sim = self._sim("bus")
        self.assertEqual(sim._hero_world, [],
                         "situation_hero is no longer a pre-filled world note")
        first = self._schedule()[0]
        self.assertEqual((first["t"], first["who"]), (0, [sim.hero]))
        self.assertEqual(first["what"], sim_mod.START["situation_hero"])
        self._silent(sim, 0.0)
        self.assertIn(first["what"], self._fired())
        self.assertIn(first["what"], sim._hero_world,
                      "the hero hears his reason as an event, not as a start value")

    # --- a tie between hero and actor goes to the actor (F9) -----------------
    def test_tied_event_hit_picks_actor_before_hero(self):
        sim = self._sim("roof")
        self._silent(sim, 0.0)  # t=0 events give Dan and Max the same event_hit
        who, role = sim._pick_speaker()
        self.assertEqual((who, role), ("Dan", "actor"),
                         "7.2 row 1.3: on a tie, Dan (scene order) answers before the hero")


if __name__ == "__main__":
    unittest.main()
