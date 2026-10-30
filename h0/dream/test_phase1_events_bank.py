"""Red test for review findings F1/F2 (spec 7.4): events metrics are first-scene
only, roof times are section 9.
usage: cd h0/dream && python3 -m unittest test_phase1_events_bank -q
"""

import json
import os
import unittest

import bank


class BankEventsTest(unittest.TestCase):
    def test_first_scene_only(self):
        rows = [{"type": "snapshot", "t": 0, "speed": 1},
                {"type": "schedule", "t": 0, "events": [{"t": 0}, {"t": 10}]},
                {"type": "event", "t": 0},
                {"type": "transition", "t": 5},
                {"type": "schedule", "t": 5, "events": [{"t": 0}, {"t": 99}]},
                {"type": "event", "t": 5}]
        m = bank.score(rows)
        self.assertEqual((m["events_fired"], m["events_planned"]), (1, 1))

    def test_open_scene_denominator_is_last_row_not_last_fired(self):
        """Review F8: a due-but-missed event must still count toward the
        denominator -- the bound is the latest row seen, not the furthest
        event that actually fired."""
        rows = [{"type": "snapshot", "t": 0, "speed": 1},
                {"type": "schedule", "t": 0,
                 "events": [{"t": 0, "what": "early"}, {"t": 10, "what": "late"}]},
                {"type": "event", "t": 0, "what": "early"},
                {"type": "silence", "t": 12}]
        m = bank.score(rows)
        self.assertEqual((m["events_fired"], m["events_planned"]), (1, 2))

    def test_roof_times_are_section9(self):
        with open(os.path.join("scenes", "roof.json"), encoding="utf-8") as f:
            events = json.load(f)["events"]
        self.assertEqual([e["t"] for e in events], [0, 120, 300, 480])
