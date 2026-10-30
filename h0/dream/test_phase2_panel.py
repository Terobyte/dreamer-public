"""Director panel: Python folds the log, the page only draws (phase 2.3).
usage: cd h0/dream && python3 -m unittest test_phase2_panel -q
"""

import http.client
import json
import os
import shutil
import tempfile
import unittest

from diagnostics import panel_state
from server import Viewer


# the dictionary this phase owes the panel: one log type -> one panel key
TYPE_TO_KEY = {
    "schedule": "schedule",
    "event": "fired",
    "door": "fired",
    "consult": "fired",
    "pressure": "pressure",
    "silence": "pressure",
    "goal": "goals",
    "judge": "goals",
    "pov": "pov",
    "lock_reject": "lock",
    "loop_cut": "lock",
    "turn_skip": "lock",
    "line_discarded": "lock",
    "safety_pause": "safety",
    "input_dropped": "safety",
    "message": "notes",
}

DICTIONARY = [
    {"type": "schedule", "t": 0, "events": [{"t": 30, "what": "phone rings"}]},
    {"type": "event", "t": 31, "what": "phone rings", "who": "Maya"},
    {"type": "door", "t": 40, "state": "open", "object": "satellite dish"},
    {"type": "consult", "t": 41, "label": "ready_stale", "verdict": "wait"},
    {"type": "judge", "t": 42, "actor": "Maya", "answer": "yes"},
    {"type": "pressure", "t": 43, "pressure": {"Maya": 0.2}},
    {"type": "silence", "t": 44, "pressure": {"Maya": 0.9}},
    {"type": "goal", "t": 45, "actor": "Maya", "goal": "find the dish", "status": "open"},
    {"type": "lock_reject", "t": 46, "who": "Maya", "reason": "name", "text": "Bob, stop"},
    {"type": "loop_cut", "t": 47, "who": "Maya", "item": "satellite dish"},
    {"type": "turn_skip", "t": 48, "who": "Squidward"},
    {"type": "line_discarded", "t": 49, "who": "Maya", "reason": "human"},
    {"type": "pov", "t": 50, "hero_owner": "human"},
    {"type": "safety_pause", "t": 51, "matched": "blood"},
    {"type": "input_dropped", "t": 52, "reason": "safety"},
    {"type": "message", "t": 53, "to": "Maya", "note": "be gentle tonight"},
]

PANEL_KEYS = {"schedule", "fired", "pressure", "goals", "pov", "lock", "notes", "safety"}


class PanelStateTest(unittest.TestCase):
    def test_panel_covers_dictionary(self):
        """Every type of the dictionary lands under its key, and only there."""
        panel = panel_state(DICTIONARY)
        self.assertEqual(set(panel), PANEL_KEYS)
        self.assertEqual(panel["schedule"], [{"t": 30, "what": "phone rings"}])
        fired = {(f.get("type"), f.get("t")) for f in panel["fired"]}
        self.assertEqual(fired, {("event", 31), ("door", 40), ("consult", 41)})
        self.assertEqual([f.get("label") for f in panel["fired"]
                          if f.get("type") == "consult"], ["ready_stale"])
        # silence is the last pressure row, so the panel shows its table and says so
        self.assertEqual(panel["pressure"],
                         {"kind": "silence", "t": 44, "actors": {"Maya": 0.9}})
        self.assertEqual(panel["goals"]["Maya"]["goal"], "find the dish")
        self.assertEqual(panel["goals"]["Maya"]["status"], "open")
        self.assertEqual(panel["goals"]["Maya"]["judge"], "yes")
        self.assertEqual(panel["pov"], "human")
        self.assertEqual([r.get("type") for r in panel["lock"]],
                         ["lock_reject", "loop_cut", "turn_skip", "line_discarded"])
        self.assertEqual(panel["lock"][0]["reason"], "name")
        self.assertEqual([r.get("type") for r in panel["safety"]],
                         ["safety_pause", "input_dropped"])
        self.assertEqual(panel["notes"], [{"to": "Maya", "note": "be gentle tonight"}])
        # each row of the dictionary is visible under exactly the key of the table
        for row in DICTIONARY:
            key = TYPE_TO_KEY[row["type"]]
            blob = json.dumps(panel[key], ensure_ascii=False, sort_keys=True)
            self.assertTrue(blob, "%s -> %s is empty" % (row["type"], key))

    def test_panel_pressure_last_tick(self):
        panel = panel_state([
            {"type": "pressure", "t": 1, "pressure": {"Maya": 0.1, "Squidward": 0.0}},
            {"type": "pressure", "t": 2, "pressure": {"Maya": 0.4, "Squidward": 0.7}}])
        self.assertEqual(panel["pressure"],
                         {"kind": "pressure", "t": 2,
                          "actors": {"Maya": 0.4, "Squidward": 0.7}})

    def test_panel_ignores_unknown(self):
        panel = panel_state([{"type": "line", "text": "hello"},
                             {"type": "snapshot", "scene": "roof3"},
                             "not a dict", None,
                             {"no type at all": 1},
                             {"type": "message", "to": "Maya", "note": "ok"}])
        self.assertEqual(set(panel), PANEL_KEYS)
        self.assertEqual(panel["notes"], [{"to": "Maya", "note": "ok"}])
        blob = json.dumps(panel, ensure_ascii=False)
        self.assertNotIn("hello", blob)
        self.assertNotIn("roof3", blob)


class ServerPanelTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        run_dir = os.path.join(self.root, "A", "run_1")
        os.makedirs(run_dir)
        # a real log numbers its rows; the panel keeps the row as written
        self.rows = [dict(row, seq=i) for i, row in enumerate(DICTIONARY, 1)]
        with open(os.path.join(run_dir, "log.jsonl"), "w", encoding="utf-8") as f:
            for row in self.rows:
                f.write(json.dumps(row) + "\n")
        self.viewer = Viewer(sim=None, run=None, root=self.root)
        self.port = self.viewer.start(0)

    def tearDown(self):
        self.viewer.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def _get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            c.request("GET", path, headers={"Host": "127.0.0.1:%d" % self.port})
            r = c.getresponse()
            return r.status, r.read()
        finally:
            c.close()

    def test_server_panel(self):
        code, body = self._get("/api/panel?run=A/run_1")
        self.assertEqual(code, 200)
        panel = json.loads(body)
        self.assertEqual(set(panel), PANEL_KEYS)
        self.assertEqual(panel, panel_state(self.rows))
        # outside the base, exactly like /events
        for bad in ("/api/panel?run=../..", "/api/panel?run=A", "/api/panel?run=A/nope"):
            self.assertEqual(self._get(bad)[0], 404, bad)


class ComicPanelTest(unittest.TestCase):
    def test_comic_polls_panel(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "comic.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertIn("'/api/panel'", html)
        self.assertRegex(html, r"setInterval\([^;]*?,\s*1000\s*\)")


if __name__ == "__main__":
    unittest.main()
