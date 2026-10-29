"""Phase 1.4 contract (spec 7.2 row 1.4): goals are decided by code, the judge
only speaks for `judge: true` goals, two YES in a row close, NO resets.
usage: cd h0/dream && python3 -m unittest test_phase1_goals -q
"""

import copy
import json
import os
import tempfile
import threading
import unittest
from unittest import mock

import llm
import sim as sim_mod
from dialogue import Dialogue
from fake import FakeTransport
from sim import Sim

CODE_GOAL = {
    "actor": "Dan",
    "goal": "Max himself says he lost the job, without being asked",
    "done_when": {
        "speaker": "Max",
        "any": ["job", "fired", "warehouse", "let go"],
        "not_after": {
            "speaker": "Dan",
            "any": ["job", "fired", "warehouse", "let go", "work"],
        },
    },
    "judge": False,
}
JUDGE_GOAL = {
    "actor": "Dan",
    "goal": "Dan gets Max to name what he is afraid of",
    "judge": True,
}


def rows(root):
    with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class StubDialogue:
    """Dialogue stand-in: lines are fed by the test, judge answers from a list."""

    def __init__(self, hero, answers=None):
        self.hero = hero
        self.event_sink = None
        self.background = False
        self.answers = list(answers or [])
        self.judge_calls = []

    def judge(self, goal, last4):
        self.judge_calls.append((goal, list(last4)))
        return self.answers.pop(0) if self.answers else "NO"


class GoalsTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        sim_mod.use_scene("roof3")
        self.addCleanup(sim_mod.use_scene, "start")

    def _sim(self, answers=None):
        self.root = tempfile.mkdtemp()
        dlg = StubDialogue("Max", answers)
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        self.assertEqual(sim.hero, "Max")
        self.assertIn("Dan", sim.actors)
        sim.scene["goals"] = copy.deepcopy([CODE_GOAL, JUDGE_GOAL])
        sim._load_goals()
        return sim, dlg

    def _say(self, sim, who, role, text):
        sim._start_line({"owner": "npc", "who": who, "role": role, "text": text})

    def _goals(self):
        return [r for r in rows(self.root) if r["type"] == "goal"]

    def _done(self):
        return [g for g in self._goals() if g.get("status") == "done"]

    # --- code closes the goal, unless the actor asked first ------------------
    def test_goal_done_by_code(self):
        sim, _ = self._sim()
        self._say(sim, "Dan", "actor", "[flat] Max, is this about work? Lost your job?")
        self._say(sim, "Max", "hero", "[flat] I got fired on Friday.")
        self.assertEqual(self._done(), [],
                         "the goal closed even though Dan asked about work first")
        self._say(sim, "Dan", "actor", "[flat] Come away from the edge, please.")
        self._say(sim, "Max", "hero", "[flat] They fired me Friday and I told no one.")
        done = self._done()
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0].get("by"), "code")
        self.assertEqual(done[0].get("actor"), "Dan")
        # the next goal of the same actor opens right after
        opened = [g for g in self._goals()
                  if g.get("status") == "open" and g.get("actor") == "Dan"]
        self.assertEqual(len(opened), 2, self._goals())

    # --- judge: two YES in a row close, NO resets, <= 1 call per 4 lines -----
    def test_judge_two_yes(self):
        sim, dlg = self._sim(answers=["YES", "NO", "YES", "YES"])
        sim.scene["goals"] = copy.deepcopy([JUDGE_GOAL])
        sim._load_goals()
        for i in range(4):
            self._say(sim, "Dan", "actor", "[flat] Talk to me, take %d." % i)
        sim._join_judge()
        self.assertEqual(len(dlg.judge_calls), 1, dlg.judge_calls)
        self.assertEqual(len(dlg.judge_calls[0][1]), 4, "the judge did not see the last 4")
        # the answer landed in the background queue, but is not applied yet:
        # a line on the turn path must not see it, only an explicit _tick does
        self._say(sim, "Dan", "actor", "[flat] Talk to me, take 4.")
        judges = [r for r in rows(self.root) if r["type"] == "judge"]
        self.assertEqual(judges, [], "a line must not apply a pending judge answer")
        sim._tick()
        judges = [r for r in rows(self.root) if r["type"] == "judge"]
        self.assertEqual([j.get("answer") for j in judges], ["YES"])
        self.assertEqual(self._done(), [], "one YES closed the goal")
        for i in range(5, 8):
            self._say(sim, "Dan", "actor", "[flat] Talk to me, take %d." % i)
        sim._join_judge()
        self.assertEqual(len(dlg.judge_calls), 2, dlg.judge_calls)
        self._say(sim, "Dan", "actor", "[flat] Talk to me, take 8.")
        sim._tick()
        judges = [r for r in rows(self.root) if r["type"] == "judge"]
        self.assertEqual([j.get("answer") for j in judges], ["YES", "NO"])
        self.assertEqual(self._done(), [],
                         "YES, NO, YES must not close: NO resets the count")
        for i in range(9, 12):
            self._say(sim, "Dan", "actor", "[flat] Talk to me, take %d." % i)
        sim._join_judge()
        self.assertEqual(len(dlg.judge_calls), 3, dlg.judge_calls)
        self._say(sim, "Dan", "actor", "[flat] Talk to me, take 12.")
        sim._tick()
        judges = [r for r in rows(self.root) if r["type"] == "judge"]
        self.assertEqual([j.get("answer") for j in judges], ["YES", "NO", "YES"])
        self.assertEqual(self._done(), [], "a single YES after NO must not close")
        for i in range(13, 16):
            self._say(sim, "Dan", "actor", "[flat] Talk to me, take %d." % i)
        sim._join_judge()
        self.assertEqual(len(dlg.judge_calls), 4, dlg.judge_calls)
        self._say(sim, "Dan", "actor", "[flat] Talk to me, take 16.")
        sim._tick()
        judges = [r for r in rows(self.root) if r["type"] == "judge"]
        self.assertEqual([j.get("answer") for j in judges],
                         ["YES", "NO", "YES", "YES"])
        done = self._done()
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0].get("by"), "judge")
        self.assertLessEqual(len(dlg.judge_calls), sim.line_count // 4,
                             "more than one judge call per 4 lines")
        # no open judge goal left: further lines cost no more calls
        for i in range(17, 22):
            self._say(sim, "Dan", "actor", "[flat] Still here, take %d." % i)
        sim._join_judge()
        self.assertEqual(len(dlg.judge_calls), 4, dlg.judge_calls)

    # --- a free tick must not wait on an in-flight judge call ----------------
    def test_tick_does_not_block_on_judge_call(self):
        block = threading.Event()
        release = threading.Event()

        class BlockingDialogue(StubDialogue):
            def judge(self, goal, last4):
                block.set()
                release.wait(2)
                return super().judge(goal, last4)

        self.root = tempfile.mkdtemp()
        dlg = BlockingDialogue("Max", ["YES"])
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dlg)
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        sim.scene["goals"] = copy.deepcopy([JUDGE_GOAL])
        sim._load_goals()
        for i in range(4):
            self._say(sim, "Dan", "actor", "[flat] Talk to me, take %d." % i)
        self.assertTrue(block.wait(2), "the judge call never started")

        done = {}

        def run_tick():
            sim._tick()
            done["ok"] = True

        t = threading.Thread(target=run_tick)
        t.start()
        t.join(1)
        self.assertFalse(t.is_alive(), "_tick() blocked on the in-flight judge call")
        self.assertTrue(done.get("ok"))
        release.set()
        sim._join_judge()

    # --- an open goal raises the actor's pressure -----------------------------
    def test_goal_open_in_pressure(self):
        sim, _ = self._sim()
        self.assertEqual(sim._pressure("Dan")["goal_open"], 1)
        self.assertEqual(sim._pressure("Max")["goal_open"], 0,
                         "the NPC hero has no goals")
        self._say(sim, "Dan", "actor", "[flat] Come away from the edge.")
        self._say(sim, "Max", "hero", "[flat] They fired me Friday and I told no one.")
        self.assertEqual(sim._pressure("Dan")["goal_open"], 1,
                         "the judge goal is still open for Dan")
        sim.scene["goals"] = copy.deepcopy([CODE_GOAL])
        sim._load_goals()
        self._say(sim, "Dan", "actor", "[flat] Come away from the edge.")
        self._say(sim, "Max", "hero", "[flat] They fired me Friday and I told no one.")
        self.assertEqual(sim._pressure("Dan")["goal_open"], 0,
                         "no open goal left, but goal_open is still 1")


class JudgeCallTest(unittest.TestCase):
    """The real Dialogue.judge over FakeTransport: role routing, what the judge
    is shown, and the strict YES/NO parse (spec 7.2 row 1.4, phase 1 fixtures)."""

    LAST4 = [("Dan", "Step back."), ("Max", "No."),
             ("Dan", "Please."), ("Max", "I am scared of the drop.")]

    def _judge(self, reply):
        t = FakeTransport([reply])
        d = Dialogue({"hero": "Max"}, transport=t)
        return d.judge("Dan gets Max to name what he is afraid of", self.LAST4), t

    def test_judge_call_is_routed_as_the_judge_role(self):
        answer, t = self._judge("YES")
        self.assertEqual(answer, "YES")
        sent = t.sent[0]
        self.assertEqual((sent["model"], sent["effort"]), llm.resolve("judge"))
        self.assertEqual(sent["system"], Dialogue.JUDGE_SYSTEM)
        user = sent["messages"][0]["content"]
        for who, text in self.LAST4:
            self.assertIn("%s: %s" % (who, text), user)
        self.assertIn("Dan gets Max to name what he is afraid of", user)

    def test_judge_parses_strictly(self):
        for reply, want in (("YES", "YES"), ("YES\n", "YES"), (" yes ", "YES"),
                            ("NO", "NO"), ("Yes, definitely", "NO"),
                            ("", "NO"), ("maybe", "NO")):
            self.assertEqual(self._judge(reply)[0], want, reply)

    def test_a_dead_transport_reads_as_no(self):
        class Dead:
            def complete(self, **kw):
                raise RuntimeError("provider down")

        d = Dialogue({"hero": "Max"}, transport=Dead())
        self.assertEqual(d.judge("any goal", self.LAST4), "NO")


if __name__ == "__main__":
    unittest.main()
