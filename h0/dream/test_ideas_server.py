"""D2: POST /event kind draft|idea|idea_drop|effect_ack and GET /ideas on the dream server."""
import json
import unittest
import urllib.request

from server import Viewer


class FakeSim:
    def __init__(self):
        self.calls = []

    def submit(self, kind, value=None):
        self.calls.append((kind, value))

    def clean_draft(self, p):
        self.calls.append(("draft", p))
        return {"draft_revision": p.get("draft_revision"), "clean": "c", "intent": "steer",
                "confidence": 0.9}

    def post_idea(self, p):
        self.calls.append(("idea", p))
        return {"ok": True, "id": p["id"]}

    def drop_idea(self, p):
        self.calls.append(("idea_drop", p))
        return {"ok": True, "id": p["id"]}

    def effect_ack(self, p):
        self.calls.append(("effect_ack", p))
        return {"ok": True, "id": p["id"]}

    def ideas_state(self):
        return {"ideas": [{"id": "a", "status": "pending"}]}


class IdeaServerTest(unittest.TestCase):
    def setUp(self):
        self.sim = FakeSim()
        self.viewer = Viewer(sim=self.sim, run=None, root=".")
        self.port = self.viewer.start(port=0)
        self.addCleanup(self.viewer.stop)
        self.base = "http://127.0.0.1:%d" % self.port

    def post(self, body):
        req = urllib.request.Request(self.base + "/event", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json",
                                              "Origin": self.base}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def test_branches_answer_sync_and_skip_the_event_path(self):
        self.assertEqual(self.post({"kind": "draft", "draft_revision": 3, "value": "x"})["draft_revision"], 3)
        self.assertEqual(self.post({"kind": "idea", "id": "a", "source": "operator", "value": "v",
                                    "intent": "steer"}), {"ok": True, "id": "a"})
        self.assertTrue(self.post({"kind": "idea_drop", "id": "a"})["ok"])
        self.assertTrue(self.post({"kind": "effect_ack", "id": "a"})["ok"])
        kinds = [c[0] for c in self.sim.calls]
        self.assertEqual(kinds, ["draft", "idea", "idea_drop", "effect_ack"])
        self.assertNotIn("event", kinds, "an idea never goes down the consult-on-every-event path")

    def test_idea_needs_id(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.post({"kind": "idea", "value": "v"})
        self.assertEqual(cm.exception.code, 400)

    def test_get_ideas(self):
        with urllib.request.urlopen(self.base + "/ideas", timeout=10) as r:
            self.assertEqual(json.loads(r.read())["ideas"][0]["id"], "a")


if __name__ == "__main__":
    unittest.main()
