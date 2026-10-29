"""Phase 2.1 contract (spec 7.2 row 2.1): the player can take the hero's turn.
hero_owner == "human" -> the NPC hero is silent until the player speaks, a hero
line already in flight or prepared is thrown away, and the viewer can ask what
the hero knows (/pov, /api/hero, spec 9, 11).
usage: cd h0/dream && python3 -m unittest test_phase2_pov -q
"""

import http.client
import json
import os
import shutil
import tempfile
import threading
import unittest
from unittest import mock

import sim as sim_mod
from dialogue import Dialogue
from fake import FakeTransport
from server import Viewer
from sim import Sim, load_profile
from test_phase1_util import manual_clock, pump


def rows(root):
    with open(os.path.join(root, "log.jsonl"), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


class GatedDialogue:
    """A scripted line held until the gate opens: "a line in flight" with no sleep."""

    def __init__(self, hero, gate):
        self.hero = hero
        self.gate = gate
        self.event_sink = None

    def _line(self, who, role):
        self.gate.wait(5)
        return {"who": who, "role": role, "text": "[flat] the wind moves.",
                "remarks": [], "raw": "[flat] the wind moves."}

    def hero_line(self, world, transcript, world_events=()):
        return self._line(self.hero, "hero")

    def actor_line(self, actor, world, transcript, state, notes=(), events=(), persona=""):
        return self._line(actor, "actor")


class PovTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        sim_mod.use_scene("roof3")
        self.addCleanup(sim_mod.use_scene, "start")

    def _sim(self, dialogue):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, dialogue=dialogue)
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        manual_clock(self, sim)
        return sim

    def _live_sim(self):
        transport = FakeTransport(reply=lambda *a: "[flat] the wind moves.")
        dlg = Dialogue(load_profile("A"), transport=transport)
        return self._sim(dlg)

    def _gated_sim(self):
        gate = threading.Event()
        sim = self._sim(GatedDialogue("Max", gate))
        return sim, gate

    def _lines(self, sim):
        return [r for r in rows(self.root) if r["type"] == "line"]

    # --- the silent hero ---------------------------------------------------
    def test_pov_human_silences_npc_hero(self):
        sim = self._live_sim()
        self.assertEqual(sim.hero_owner, "npc")
        sim.set_pov("human")
        pump(sim, 30)
        for r in self._lines(sim):
            self.assertFalse(r.get("turn_owner") == "npc" and r.get("who") == sim.hero,
                             "the NPC hero spoke while the player owns him: %r" % r)
        for r in rows(self.root):
            if r["type"] == "pressure":
                self.assertNotIn(sim.hero, r["pressure"])
        pov = [r for r in rows(self.root) if r["type"] == "pov"]
        self.assertEqual(len(pov), 1)
        self.assertEqual(pov[0]["hero_owner"], "human")
        self.assertIn("t", pov[0])

    def test_pov_back_to_npc_resumes(self):
        sim = self._live_sim()
        mind = sim.dialogue.mind(sim.hero)
        sim.set_pov("human")
        pump(sim, 3)
        sim.set_pov("npc")
        self.assertEqual(sim.hero_owner, "npc")
        for _ in range(30):
            pump(sim)
            if any(r.get("who") == sim.hero and r.get("turn_owner") == "npc"
                   for r in self._lines(sim)):
                break
        else:
            self.fail("the hero never spoke again after the player gave the turn back")
        self.assertIs(sim.dialogue.mind(sim.hero), mind)

    def test_pov_no_actors_picks_nobody(self):
        sim = self._live_sim()
        sim.actors = []
        sim.hero_owner = "human"
        self.assertEqual(sim._pick_speaker(), (None, None))

    # --- a line in flight ---------------------------------------------------
    def test_pov_discards_hero_in_flight(self):
        sim, gate = self._gated_sim()
        with mock.patch.object(sim, "_pick_speaker", return_value=(sim.hero, "hero")):
            pump(sim)
        self.assertEqual(sim._gen_who, sim.hero)
        epoch = sim._turn_epoch
        sim.set_pov("human")
        self.assertEqual(sim._turn_epoch, epoch + 1)
        gate.set()
        pump(sim, 2)  # one step joins the held worker, the next picks its line up
        dropped = [r for r in rows(self.root) if r["type"] == "line_discarded"]
        self.assertTrue(any(r.get("who") == sim.hero and r.get("reason") == "human"
                            for r in dropped), dropped)
        self.assertFalse([r for r in rows(self.root) if r["type"] == "transition"])

    def test_pov_keeps_actor_in_flight(self):
        sim, gate = self._gated_sim()
        with mock.patch.object(sim, "_pick_speaker", return_value=("Dan", "actor")):
            pump(sim)
        self.assertEqual(sim._gen_who, "Dan")
        sim.set_pov("human")
        gate.set()
        pump(sim, 2)  # one step joins the held worker, the next picks its line up
        self.assertTrue(any(r.get("who") == "Dan" for r in self._lines(sim)))
        self.assertFalse([r for r in rows(self.root) if r["type"] == "line_discarded"])

    def test_pov_drops_prepared_hero(self):
        sim, gate = self._gated_sim()
        sim.npc_start({"who": "Dan", "role": "actor", "text": "[flat] one."})
        sim.npc_start({"who": sim.hero, "role": "hero", "text": "[flat] two."})
        self.assertIsNotNone(sim.prepared_npc)
        sim.set_pov("human")
        self.assertIsNone(sim.prepared_npc)
        dropped = [r for r in rows(self.root) if r["type"] == "line_discarded"]
        self.assertTrue(any(r.get("who") == sim.hero and r.get("reason") == "human"
                            for r in dropped), dropped)


class PovServerTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        run_dir = os.path.join(self.root, "A", "run_1")
        os.makedirs(run_dir)
        self.sim = Sim(profile="A", fake=True, speed=1.0, outdir=run_dir)
        self.addCleanup(self.sim.close)
        self.viewer = Viewer(sim=self.sim, run="A/run_1", root=self.root)
        self.port = self.viewer.start(0)
        self.addCleanup(self.viewer.stop)

    def _req(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": "127.0.0.1:%d" % self.port}
        h.update(headers or {})
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def _post(self, path, obj, headers=None):
        h = {"Content-Type": "application/json"}
        h.update(headers or {})
        return self._req("POST", path, json.dumps(obj).encode(), h)

    def test_server_pov(self):
        st, _ = self._post("/pov", {"hero_owner": "human"})
        self.assertEqual(st, 200)
        self.sim._drain_inbox()
        self.assertEqual(self.sim.hero_owner, "human")
        self.assertEqual(self._post("/pov", {"hero_owner": "x"})[0], 400)
        self.assertEqual(self._post("/pov", {"hero_owner": "npc"},
                                    {"Origin": "http://evil.com"})[0], 403)
        st, data = self._req("GET", "/api/hero")
        self.assertEqual(st, 200)
        body = json.loads(data)
        prof = load_profile("A")
        want = [f["text"] for f in prof["facts"] if not f.get("hidden_from_hero")]
        hidden = [f["text"] for f in prof["facts"] if f.get("hidden_from_hero")]
        self.assertEqual(body["facts"], want)
        for text in hidden:
            self.assertNotIn(text, body["facts"])
        self.assertEqual(body["diary"], [prof["diary"]])
        self.viewer.sim = None
        self.assertEqual(self._post("/pov", {"hero_owner": "npc"})[0], 409)
        st, data = self._req("GET", "/api/hero")
        self.assertEqual(st, 409)
        self.assertEqual(json.loads(data)["error"], "no live dream")

    def test_comic_asks_for_pov_and_hero(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "comic.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertIn("fetch('/pov'", html)
        self.assertIn("fetch('/api/hero'", html)
        pov = html.split("fetch('/pov'")[1][:200]
        self.assertIn("application/json", pov)
        for eid in ("povbtn", "herobtn", "herobox"):
            self.assertIn('id="%s"' % eid, html)


if __name__ == "__main__":
    unittest.main()
