"""Red contract tests for sim (spec 4, 6, 8, 10): human replaces NPC, slow director, jsonl.
usage: cd h0/dream && python3 -m unittest test_sim -q
"""
import unittest


class HumanReplacesNpcTest(unittest.TestCase):
    def test_human_replaces_npc(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        s.npc_start("line already playing")
        active_before = dict(s.active_line)
        s.npc_start("prepared npc line about the porch")
        self.assertEqual(s.prepared_npc, "prepared npc line about the porch")
        ev = s.human_say("my own line")
        kinds = [e["type"] for e in ev]
        self.assertIn("turn_replace", kinds)
        rep = [e for e in ev if e["type"] == "turn_replace"][0]
        self.assertEqual(rep.get("turn_owner"), "human")
        self.assertTrue(s.playing)
        # the line already playing was not interrupted
        self.assertEqual(s.active_line, active_before)
        # the prepared npc line was dropped, human line queued next
        self.assertIsNone(s.prepared_npc)
        self.assertEqual(s.next_line, {"owner": "human", "text": "my own line"})

    def test_human_line_reaches_director(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        s.human_say("the dart went wide")
        s.director.wait()
        self.assertTrue(any("dart" in p for p in s.director.prompts))
        self.assertTrue(any("[HUMAN_SAYS:" in p for p in s.director.prompts))
        self.assertTrue(s.director.out_of_turn)

    def test_human_say_logs_speech_input_event(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        ev = s.human_say("the dart went wide")
        inputs = [e for e in ev if e["type"] == "input"]
        self.assertEqual(len(inputs), 1)
        self.assertEqual(inputs[0]["source"], "speech")
        self.assertEqual(inputs[0]["value"], "the dart went wide")


class LineLoopTest(unittest.TestCase):
    def test_npc_lines_trigger_consult_every_four(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        for i in range(4):
            s.npc_start("line %d" % i)
        self.assertTrue(s.director.in_flight or s.director.completed_events
                        or s.director.prompts)

    def test_run_emits_line_events(self):
        import json
        from sim import run
        outdir, logpath = run(profile="A", fake=True, speed=20,
                               max_transitions=1, seed=2)
        with open(logpath, encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        self.assertTrue(any(r["type"] == "line" for r in rows))


class TransitionKeepsFullActorsTest(unittest.TestCase):
    def test_transition_preserves_voice_and_hero_next(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        s.fsm.start_build(s.clock.now(), s.fsm.objects[0], "porch",
                          next_scene={"actors": [{"name": "Grandma", "voice": "old_woman"}],
                                      "objects": ["a", "b", "c", "d", "e"]},
                          hero_next={"changes": True, "voice": "child"})
        s._apply_transition()
        self.assertEqual(s.scene["actors"], [{"name": "Grandma", "voice": "old_woman"}])
        self.assertEqual(s.actors, ["Grandma"])
        self.assertEqual(s.hero_next, {"changes": True, "voice": "child"})


class StressSlowDirectorTest(unittest.TestCase):
    def test_stress_slow_director(self):
        from sim import run_stress
        rep = run_stress(delay=8.0, speed=20, seed=7)
        self.assertGreaterEqual(rep["consult_stale"], 1)
        self.assertEqual(rep["bridge_changes_in_building"], 0)
        self.assertEqual(rep["exceptions"], 0)


class LogJsonlTest(unittest.TestCase):
    def test_log_jsonl(self):
        import json
        import os
        from sim import run
        outdir, logpath = run(profile="A", fake=True, speed=20,
                               max_transitions=1, seed=1)
        with open(logpath, encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        self.assertGreater(len(rows), 0)
        seqs = [r["seq"] for r in rows]
        self.assertEqual(seqs, list(range(1, len(rows) + 1)))
        for r in rows:
            self.assertIn("t", r)
            self.assertIn("type", r)
        self.assertEqual(rows[0]["type"], "snapshot")
        cdir = os.path.join(outdir, "consults")
        self.assertTrue(os.path.isdir(cdir))
        txts = sorted(f for f in os.listdir(cdir) if f.endswith(".txt"))
        self.assertGreater(len(txts), 0)
        self.assertLessEqual(len(txts), 50)
        with open(os.path.join(cdir, txts[-1]), encoding="utf-8") as f:
            self.assertGreater(len(f.read()), 0)


if __name__ == "__main__":
    unittest.main()
