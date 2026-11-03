"""D4 (specs/2026-11-02-director-prompt.md, 2а): the operator's "inside the shop" idea
starts a cache build on the FSM: door locked + placard at start_build, the NPCs keep the
hero talking (stall) for the rest of build_pct, then door open -> goto -> walk_through ->
Sim.place == destination. Fake LLM, fake clocks, no network."""

import json
import os
import tempfile
import unittest
from unittest import mock

import fsm as fsm_mod
from fsm import BuildFSM
from sim import Sim


class Wall:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FSMCacheModeTest(unittest.TestCase):
    def test_live_no_build_still_refuses(self):
        f = BuildFSM(["door"], no_build=True)
        self.assertEqual(f.start_build(0, "door", "bathroom")[0]["type"], "invalid")

    def test_live_default_events_unchanged(self):
        f = BuildFSM(["door"])
        ev = f.start_build(0, "door", "bathroom")
        self.assertEqual([e["type"] for e in ev], ["build"])

    def test_cache_mode_locks_door_at_start_then_opens_on_ready(self):
        f = BuildFSM(["door"], no_build=True, build_mode="cache", params={"build": 45})
        ev = f.start_build(0, "door", "bathroom")
        self.assertEqual(ev[0]["type"], "build")
        self.assertIn({"type": "door", "t": 0, "state": "locked", "object": "door"}, ev)
        self.assertEqual(f.tick(44.0), [])
        ev = f.tick(45.0)
        self.assertEqual([e["type"] for e in ev], ["ready", "door"])
        self.assertEqual(ev[1]["state"], "open")

    def test_walk_through_only_from_ready(self):
        f = BuildFSM(["door"], no_build=True, build_mode="cache", params={"build": 45})
        self.assertEqual(f.walk_through(0)[0]["type"], "invalid")
        f.start_build(0, "door", "bathroom")
        self.assertEqual(f.walk_through(10)[0]["type"], "invalid")
        f.tick(45)
        ev = f.walk_through(46)
        self.assertEqual(ev[0]["type"], "transition")
        self.assertEqual(ev[0]["via"], "npc_walk")
        self.assertEqual(f.state, "transition")


class SceneBuildSimTest(unittest.TestCase):
    BUILD = 45

    def make(self, build=None):
        self.root = tempfile.mkdtemp()
        sim = Sim(profile="A", fake=True, speed=1.0, outdir=self.root, no_build=True,
                  build_mode="cache", fsm_params={"build": build or self.BUILD},
                  scene_world="koshakan")
        self.addCleanup(sim.close)
        self.enterContext(mock.patch.object(sim.director, "consult_async"))
        self.wall = Wall()
        sim.ideas.wall = self.wall
        self.t = [0.0]
        sim.clock.now = lambda: self.t[0]
        sim.fsm.new_scene(0.0, sim.fsm.objects)
        return sim

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.sim = self.make()

    def journal(self):
        with open(os.path.join(self.root, "log.jsonl"), encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def shop(self, id_="s1", sim=None):
        sim = sim or self.sim
        sim.cleaner = lambda raw: {"clean": raw, "intent": "scene", "confidence": 0.9}
        r = sim.post_idea({"kind": "idea", "id": id_, "source": "operator",
                           "value": "внутри магазина, начни строить сейчас"})
        sim._idea_step()
        return r

    def advance(self, until, step=1.0, sim=None):
        sim = sim or self.sim
        while self.t[0] < until:
            self.t[0] += step
            self.wall.t += step
            sim._tick()

    def test_registry_test_world_alias(self):
        entry = self.sim.scene_registry["koshakan_shop"]
        self.assertEqual((entry["bridge"], entry["destination"]), ("door", "bathroom"))
        self.assertEqual(len(entry["stall_bank"]), 3)
        self.assertIn("kozb7_yard_shop", Sim.SCENE_WORLDS["kozb7_yard"])

    def test_fire_locks_door_with_placard_and_opens_on_ready(self):
        r = self.shop()
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.sim.ideas.get("s1")["scene_id"], "koshakan_shop")
        self.assertEqual(self.sim.fsm.state, "building")
        self.assertEqual(self.sim.ideas.effect_ack("s1")["ok"], True)
        self.assertEqual(self.sim.ideas.get("s1")["status"], "done")
        j = self.journal()
        doors = [e for e in j if e["type"] == "door"]
        self.assertEqual(doors[-1]["state"], "locked")
        plac = [e for e in j if e["type"] == "placard"]
        self.assertEqual(plac[-1]["door"], "door")
        self.assertEqual(plac[-1]["id"], "s1")
        self.assertTrue(plac[-1]["text"])
        self.advance(self.BUILD - 1)
        self.assertFalse(any(e["type"] == "door" and e.get("state") == "open"
                             for e in self.journal()))
        self.advance(self.BUILD + 30)
        j = self.journal()
        opened = [i for i, e in enumerate(j) if e["type"] == "door" and e.get("state") == "open"]
        self.assertTrue(opened)
        after = j[opened[0]:]
        self.assertTrue(any(e["type"] == "placard" and e.get("clear") for e in after))
        gotos = [e for e in after if e["type"] == "stage" and e.get("action") == "goto"]
        self.assertEqual(gotos[0]["who"], self.sim.hero)
        self.assertEqual(gotos[0]["place"], "bathroom")
        self.assertTrue(any(e["type"] == "transition" and e.get("via") == "npc_walk"
                            for e in after))
        self.assertEqual(self.sim.place, "bathroom")

    def test_stall_length_from_build_pct(self):
        self.shop()
        self.assertAlmostEqual(self.sim.stall_seconds(), 45, delta=0.5)
        self.advance(15)
        self.assertAlmostEqual(self.sim.stall_seconds(), 30, delta=1.0)
        self.assertTrue(self.sim._stall_topic)  # the stall topic, any NPC
        other = self.make(build=90)
        self.shop("s2", sim=other)
        self.assertAlmostEqual(other.stall_seconds(), 90, delta=0.5)

    def test_no_silence_over_15s_with_hung_director(self):
        self.shop()
        self.sim.director.in_flight = True  # a consult that never comes back
        self.sim.fsm.in_flight = True
        self.sim.fsm.last_call = 0.0
        silent, worst = 0.0, 0.0
        while self.t[0] < self.BUILD:
            self.t[0] += 0.5
            self.wall.t += 0.5
            self.sim._tick()
            silent = 0.0 if self.sim.active_line is not None else silent + 0.5
            worst = max(worst, silent)
        self.assertLessEqual(worst, 15.0)
        bank = self.sim.scene_registry["koshakan_shop"]["stall_bank"]
        said = [e.get("text") for e in self.journal() if e["type"] == "line"]
        self.assertTrue(any(t in bank for t in said), said)
        self.assertTrue(any(e["type"] == "consult_abandoned" for e in self.journal()))
        self.assertFalse(self.sim.director.in_flight)

    def test_abort_clears_placard_keeps_door_locked_and_hero_speaks(self):
        self.shop()
        self.sim.ideas.effect_ack("s1")
        self.advance(5)
        self.sim.abort_build("test")
        j = self.journal()
        self.assertTrue(any(e["type"] == "placard" and e.get("clear") for e in j))
        doors = [e for e in j if e["type"] == "door"]
        self.assertEqual(doors[-1]["state"], "locked")
        acks = [e for e in j if e["type"] == "director_ack" and e["id"] == "s1"]
        self.assertEqual(acks[-1]["text"], "не вышло, повтори идею")
        self.assertEqual(self.sim.ideas.get("s1")["status"], "done")
        t0 = self.t[0]
        self.advance(t0 + 20)
        hero_lines = [e for e in self.journal() if e["type"] == "line"
                      and e.get("who") == self.sim.hero and e["t"] > t0]
        self.assertTrue(hero_lines)
        self.assertEqual(self.shop("s1"), {"ok": True, "id": "s1"})
        self.assertEqual(self.sim.fsm.state, "idle")
        self.shop("s3")
        self.assertEqual(self.sim.fsm.state, "building")


class SliceEndToEndTest(SceneBuildSimTest):
    """Slice acceptance on the test world: "поговорите о сестре", then "внутри магазина,
    начни строить сейчас" -> door locked with the placard, talk until ready, door open,
    the hero walks into the shop room. No manual step but the engine's effect_ack."""

    def test_sister_then_shop(self):
        sim = self.sim
        sim.cleaner = lambda raw: {"clean": raw, "intent": "steer", "confidence": 0.9}
        self.assertTrue(sim.post_idea({"kind": "idea", "id": "t1", "source": "operator",
                                       "value": "поговорите о сестре"})["ok"])
        sim._idea_step()
        self.assertEqual(sim.ideas.get("t1")["status"], "done")
        self.assertIn("сестре", sim._line_notes(sim.actors[0])[0])
        self.shop("t2")
        sim.ideas.effect_ack("t2")
        lines, silent, worst = 0, 0.0, 0.0
        while sim.fsm.state == "building":
            self.t[0] += 0.5
            self.wall.t += 0.5
            sim._tick()
            silent = 0.0 if sim.active_line is not None else silent + 0.5
            worst = max(worst, silent)
        self.assertLessEqual(worst, 15.0)
        j = self.journal()
        types = [(e["type"], e.get("state") or e.get("phase") or e.get("action")) for e in j]
        i_lock = types.index(("door", "locked"))
        i_open = types.index(("door", "open"))
        self.assertLess(i_lock, i_open)
        self.assertGreater(sum(1 for e in j[i_lock:i_open] if e["type"] == "line"), 0)
        self.assertEqual(sim.place, "bathroom")
        self.assertEqual(sim.ideas.get("t2")["status"], "done")


class PlumbingTest(unittest.TestCase):
    def test_sim_run_passes_build_mode_and_fsm_params(self):
        import sim as sim_mod
        got = {}

        class Stop(Exception):
            pass

        def fake_sim(**kw):
            got.update(kw)
            raise Stop()
        with mock.patch.object(sim_mod, "Sim", side_effect=fake_sim):
            with self.assertRaises(Stop):
                sim_mod.run(profile="A", fake=True, max_seconds=0.1, no_build=True,
                            build_mode="cache", fsm_params={"build": 30})
        self.assertEqual(got["build_mode"], "cache")
        self.assertEqual(got["fsm_params"], {"build": 30})

    def test_make_play_flags(self):
        import importlib
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
        play = importlib.import_module("make.play")
        got = {}
        with mock.patch.object(play, "play", side_effect=lambda *a, **kw: got.update(kw) or ("o", "l")):
            play.main(["run", "--fake", "--director-prompt", "--cache-build-s", "30"])
        self.assertEqual(got["build_mode"], "cache")
        self.assertEqual(got["fsm_params"], {"build": 30.0})
        got.clear()
        with mock.patch.object(play, "play", side_effect=lambda *a, **kw: got.update(kw) or ("o", "l")):
            play.main(["run", "--fake", "--director-prompt"])
        self.assertEqual(got["fsm_params"], {"build": 45.0})
        got.clear()
        with mock.patch.object(play, "play", side_effect=lambda *a, **kw: got.update(kw) or ("o", "l")):
            play.main(["run", "--fake"])
        self.assertNotIn("build_mode", got)

    def test_play_forwards_to_run(self):
        import importlib
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
        play = importlib.import_module("make.play")
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "stage"))
        with open(os.path.join(d, "stage", "stage.json"), "w") as fh:
            json.dump({"mode": "seed", "seed": "a room", "objects": ["door", "bed"]}, fh)
        got = {}
        import sim as sim_mod
        with mock.patch.object(sim_mod, "seed_start", return_value=({}, [])):
            play.play(d, fake=True, run=lambda **kw: got.update(kw) or ("o", "l"),
                      build_mode="cache", fsm_params={"build": 30})
        self.assertEqual(got["build_mode"], "cache")
        self.assertEqual(got["fsm_params"], {"build": 30})


if __name__ == "__main__":
    unittest.main()


class CacheBuildDurationTest(unittest.TestCase):
    """F16: cache_build_s must be positive, refused before any build starts."""

    def test_non_positive_cache_build_refused(self):
        for bad in (0, -5, None, "x"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    BuildFSM(["door"], no_build=True, build_mode="cache", params={"build": bad})
                with self.assertRaises(ValueError):
                    Sim(fake=True, outdir=tempfile.mkdtemp(), no_build=True, build_mode="cache",
                        fsm_params={"build": bad}, scene_world="koshakan")

    def test_live_mode_unchanged(self):
        BuildFSM(["door"], build_mode="live", params={"build": 420})
