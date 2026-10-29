"""Blind A/B in the comic viewer (Oct 29): the owner's ear is the judge, not the gate.

A run's first snapshot names its talk model and prompt version, so runs of
different prompt versions can be told apart later. The viewer serves pairs of
runs with the labels hidden and the A/B order shuffled, records each verdict
with the labels resolved, and reveals the tally only once every pair is judged.
Offline. usage: cd h0/dream && python3 -m unittest test_ab -q
"""

import http.client
import json
import os
import random
import shutil
import tempfile
import unittest
from unittest import mock

import dialogue
import llm
from dialogue import Dialogue
from fake import FakeTransport
from server import Viewer
from sim import Sim, load_profile


def _rows(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


class SnapshotVersionTest(unittest.TestCase):
    def test_first_snapshot_names_talk_model_and_prompt_version(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        dlg = Dialogue(load_profile("A"), transport=FakeTransport(reply=lambda *a: "[flat] No."),
                       rng=random.Random(0))
        dlg.background = False
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=root, dialogue=dlg)
        self.addCleanup(sim.close)
        snap = [r for r in _rows(os.path.join(root, "log.jsonl")) if r["type"] == "snapshot"][0]
        self.assertEqual(snap["talk"], llm.talk_model_name())
        self.assertEqual(snap["prompt"], dialogue.PROMPT_VERSION)
        self.assertRegex(dialogue.PROMPT_VERSION, r"^[0-9a-f]{8}$")

    def test_prompt_version_follows_the_voice_rules(self):
        with mock.patch.object(dialogue, "VOICE_RULES", dialogue.VOICE_RULES + " x"):
            self.assertNotEqual(dialogue.prompt_version(), dialogue.PROMPT_VERSION)


class AbServerTest(unittest.TestCase):
    PAIRS = [{"id": "roof-1", "runs": {"bank/run_1": "v1", "bank/run_2": "r2"}},
             {"id": "roof-2", "runs": {"bank/run_3": "v1", "bank/run_4": "r2"}}]

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        for n in range(1, 5):
            d = os.path.join(self.root, "bank", "run_%d" % n)
            os.makedirs(d)
            with open(os.path.join(d, "log.jsonl"), "w") as f:
                f.write(json.dumps({"seq": 1, "type": "line", "text": "l"}) + "\n")
        os.makedirs(os.path.join(self.root, "ab"))
        with open(os.path.join(self.root, "ab", "pairs.json"), "w") as f:
            json.dump(self.PAIRS, f)
        self.viewer = Viewer(sim=None, run=None, root=self.root)
        self.port = self.viewer.start(0)
        self.addCleanup(self.viewer.stop)

    def _req(self, method, path, obj=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": "127.0.0.1:%d" % self.port}
        body = None
        if obj is not None:
            body = json.dumps(obj).encode()
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, (json.loads(data) if data[:1] in (b"{", b"[") else data)

    def test_pairs_hide_the_labels_and_shuffle_the_order(self):
        st, data = self._req("GET", "/api/ab")
        self.assertEqual(st, 200)
        self.assertEqual([p["id"] for p in data["pairs"]], ["roof-1", "roof-2"])
        for p in data["pairs"]:
            self.assertEqual(set(p) - {"done"}, {"id", "a", "b"})
            self.assertEqual({p["a"], p["b"]}, set(self.PAIRS[0 if p["id"] == "roof-1" else 1]["runs"]))
            self.assertFalse(p["done"])
        self.assertNotIn("v1", json.dumps(data))
        self.assertNotIn("summary", data)
        # the order is fixed for this server, not per request: the page and the verdict agree
        self.assertEqual(data["pairs"], self._req("GET", "/api/ab")[1]["pairs"])
        orders = set()
        for salt in range(20):
            self.viewer.ab_salt = str(salt)
            orders.add(self._req("GET", "/api/ab")[1]["pairs"][0]["a"])
        self.assertEqual(len(orders), 2, "the A/B order never changes with the salt")

    def test_verdict_is_written_with_the_labels_and_the_tally_waits_for_all(self):
        pairs = self._req("GET", "/api/ab")[1]["pairs"]
        p = pairs[0]
        st, data = self._req("POST", "/api/ab", {"id": p["id"], "a": p["a"], "b": p["b"], "pick": "a"})
        self.assertEqual(st, 200)
        self.assertEqual(data, {"ok": True, "done": 1, "total": 2})
        rows = _rows(os.path.join(self.root, "ab", "verdicts.jsonl"))
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["id"], "roof-1")
        self.assertEqual(r["pick"], "a")
        self.assertEqual(r["a_label"], self.PAIRS[0]["runs"][p["a"]])
        self.assertEqual(r["winner"], self.PAIRS[0]["runs"][p["a"]])
        self.assertIn("t", r)
        data = self._req("GET", "/api/ab")[1]
        self.assertTrue(data["pairs"][0]["done"])
        self.assertNotIn("summary", data, "no tally while a pair is still open")
        q = pairs[1]
        self._req("POST", "/api/ab", {"id": q["id"], "a": q["a"], "b": q["b"], "pick": "same"})
        data = self._req("GET", "/api/ab")[1]
        won = self.PAIRS[0]["runs"][p["a"]]
        self.assertEqual(data["summary"], {won: 1, ("r2" if won == "v1" else "v1"): 0, "same": 1})

    def test_bad_verdicts_are_refused(self):
        p = self._req("GET", "/api/ab")[1]["pairs"][0]
        bad = [{"id": "nope", "a": p["a"], "b": p["b"], "pick": "a"},
               {"id": p["id"], "a": p["a"], "b": "bank/run_3", "pick": "a"},
               {"id": p["id"], "a": p["a"], "b": p["b"], "pick": "c"}]
        for body in bad:
            self.assertEqual(self._req("POST", "/api/ab", body)[0], 400, body)
        self.assertFalse(os.path.exists(os.path.join(self.root, "ab", "verdicts.jsonl")))

    def test_ab_page_and_blind_comic(self):
        st, page = self._req("GET", "/ab")
        self.assertEqual(st, 200)
        self.assertIn(b"/api/ab", page)
        self.assertIn(b"blind=1", page)
        st, comic = self._req("GET", "/comic.html")
        self.assertIn(b'Q.get("blind")', comic)

    def test_no_pairs_file_is_an_empty_list(self):
        os.remove(os.path.join(self.root, "ab", "pairs.json"))
        self.assertEqual(self._req("GET", "/api/ab")[1], {"pairs": []})


if __name__ == "__main__":
    unittest.main()
