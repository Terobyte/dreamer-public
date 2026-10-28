"""Regression coverage for phase-2 debt F4 and F5 (offline)."""
import unittest

from test_fsm import fsm, good, types


class WakeupDebtTest(unittest.TestCase):
    def pending_fsm(self):
        f = fsm()
        f.start_build(0, "clarinet", "porch")
        ticket = f.begin_consult(1)
        f.abort(2, "retry")
        f.finish_consult(3, ticket, {"wake_up": "distress"})
        return f

    def test_pending_survives_bad_json_until_valid_reply(self):
        f = self.pending_fsm()
        pending = dict(f.pending_wakeup)
        for now in (4, 6):
            ticket = f.begin_consult(now)
            self.assertEqual(ticket["pending_wakeup"], pending)
            events = f.finish_consult(now + 1, ticket, "broken JSON")
            self.assertIn("invalid", types(events))
            self.assertEqual(f.pending_wakeup, pending)
        ticket = f.begin_consult(8)
        self.assertEqual(ticket["pending_wakeup"], pending)
        f.finish_consult(9, ticket, {"bridge": None})
        self.assertIsNone(f.pending_wakeup)
        self.assertIsNone(f.begin_consult(10)["pending_wakeup"])

    def test_budget_wakeup_resets_real_failure_streak(self):
        f = self.pending_fsm()
        f.tick(303)
        for now in (304, 306):
            ticket = f.begin_consult(now)
            self.assertEqual(ticket["label"], "forced")
            f.finish_consult(now + 1, ticket, None)
        self.assertEqual(f.fail_streak, 2)
        ticket = f.begin_consult(308)
        events = f.budget_wakeup(309)
        self.assertEqual(f.fail_streak, 0)
        self.assertIsNone(f.pending_wakeup)
        self.assertTrue(f.awake)
        self.assertEqual([e["reason"] for e in events if e["type"] == "wake_up"], ["budget"])
        late = f.finish_consult(310, ticket, good())
        self.assertIn("consult_stale", types(late))
        self.assertNotIn("build", types(late))
        self.assertEqual(f.fail_streak, 0)


if __name__ == "__main__":
    unittest.main()
