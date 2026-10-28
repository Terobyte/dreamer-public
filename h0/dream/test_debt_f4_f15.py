"""Regression for phase debt: F4 (pending_wakeup on an invalid reply) and F15 (fact pick cache).
usage: cd h0/dream && python3 -m unittest test_debt_f4_f15 -q
"""
import tempfile
import unittest

from fake import FakeTransport
from memory import Memory
from test_contract_r12 import fill_old_facts
from test_fsm import fsm, good, types


class PendingInvalidTest(unittest.TestCase):
    def pending_fsm(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        ticket = f.begin_consult(1)
        f.abort(2, "retry")
        f.finish_consult(3, ticket, {"wake_up": "distress"})
        return f

    def test_pending_survives_invalid_bridge(self):
        f = self.pending_fsm()
        pending = dict(f.pending_wakeup)
        ticket = f.begin_consult(4)
        events = f.finish_consult(5, ticket, good("not in scene"))
        self.assertIn("invalid", types(events))
        self.assertEqual(f.pending_wakeup, pending)
        ticket = f.begin_consult(30)
        self.assertEqual(ticket["pending_wakeup"], pending)
        f.finish_consult(31, ticket, good())
        self.assertIsNone(f.pending_wakeup)

    def test_pending_survives_forced_null_bridge(self):
        f = self.pending_fsm()
        pending = dict(f.pending_wakeup)
        f.tick(303)
        ticket = f.begin_consult(304)
        self.assertEqual(ticket["label"], "forced")
        events = f.finish_consult(305, ticket, {"bridge": None})
        self.assertIn("director_fail", types(events))
        self.assertEqual(f.pending_wakeup, pending)


class FactPickCacheTest(unittest.TestCase):
    def picked_mem(self):
        t = FakeTransport(["f35 f36 f37 f38"])
        m = Memory(tempfile.mkdtemp(), transport=t)
        fill_old_facts(m)
        m.set_scene("lagoon", ["rock"])
        m.select_facts_background().join(2)
        ids = [f["id"] for f in m._facts_for_prompt()]
        self.assertEqual(ids[:4], ["f35", "f36", "f37", "f38"])
        return m, t

    def test_update_keeps_spark_pick(self):
        m, t = self.picked_mem()
        m.apply_facts([{"op": "UPDATE", "id": "f1", "supersedes_id": "f1",
                        "fact": {"title": "old1", "text": "updated"}}])
        ids = [f["id"] for f in m._facts_for_prompt()]
        for fid in ("f35", "f36", "f37", "f38"):
            self.assertIn(fid, ids)
        self.assertNotIn("f1", ids)
        self.assertNotIn("f2", ids)
        self.assertIn("updated", m.build_prompt({})[0])
        self.assertEqual(t.calls, 1)

    def test_delete_drops_only_that_fact(self):
        m, _ = self.picked_mem()
        m.apply_facts([{"op": "DELETE", "id": "f36"}])
        ids = [f["id"] for f in m._facts_for_prompt()]
        self.assertEqual(ids, ["f35", "f37", "f38"])


if __name__ == "__main__":
    unittest.main()
