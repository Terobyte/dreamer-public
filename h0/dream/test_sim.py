"""Red contract tests for sim (spec 4, 6, 8, 10): human replaces NPC, slow director, jsonl.
usage: cd h0/dream && python3 -m unittest test_sim -q
"""
import json
import os
import tempfile
import unittest
from unittest import mock

from memory import Memory
from sim import Sim


class HumanReplacesNpcTest(unittest.TestCase):
    def test_human_replaces_npc(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        self.addCleanup(s.close)
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
        self.addCleanup(s.close)
        s.human_say("the dart went wide")
        s.director.wait()
        self.assertTrue(any("dart" in p for p in s.director.prompts))
        self.assertTrue(any("[HUMAN_SAYS:" in p for p in s.director.prompts))
        self.assertTrue(s.director.out_of_turn)

    def test_human_say_logs_speech_input_event(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        self.addCleanup(s.close)
        ev = s.human_say("the dart went wide")
        inputs = [e for e in ev if e["type"] == "input"]
        self.assertEqual(len(inputs), 1)
        self.assertEqual(inputs[0]["source"], "speech")
        self.assertEqual(inputs[0]["value"], "the dart went wide")


class LineLoopTest(unittest.TestCase):
    def test_npc_lines_trigger_consult_every_four(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        self.addCleanup(s.close)
        for i in range(4):
            s.npc_start("line %d" % i)
            s._line_started_at = s.clock.now() - 2
            s._cycle_line()
        self.assertTrue(s.director.in_flight or s.director.completed_events
                        or s.director.prompts)

    def test_run_emits_line_events(self):
        import json
        from sim import run
        outdir, logpath = run(profile="A", fake=True, speed=100, max_seconds=3,
                               max_transitions=1, seed=2)
        with open(logpath, encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        self.assertTrue(any(r["type"] == "line" for r in rows))


class TransitionKeepsFullActorsTest(unittest.TestCase):
    def test_transition_preserves_voice_and_hero_next(self):
        from sim import Sim
        s = Sim(profile="A", fake=True, speed=20)
        self.addCleanup(s.close)
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
        rep = run_stress(delay=1.6, speed=100, seed=7, max_seconds=2.4)  # same 160 sim-s, 5x faster
        self.assertGreaterEqual(rep["consult_stale"], 1)
        self.assertEqual(rep["bridge_changes_in_building"], 0)
        self.assertEqual(rep["exceptions"], 0)


class LogJsonlTest(unittest.TestCase):
    def test_log_jsonl(self):
        import json
        import os
        from sim import run
        outdir, logpath = run(profile="A", fake=True, speed=100, max_seconds=3,
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


class SimOpenBugsTest(unittest.TestCase):
    """B2/B4/B5/B9: exercise normal turn order with a manually advanced clock."""

    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = root.name
        self.now = 0.0
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))

    def _sim(self, speed=1):
        sim = Sim(fake=True, speed=speed, outdir=self.root)
        self.addCleanup(sim.close)
        clock = mock.patch.object(sim.clock, "now", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        return sim

    def _silence_director(self, sim):
        # These turn tests must not start a background build or consult.
        patch = mock.patch.object(sim.director, "consult_async")
        patch.start()
        self.addCleanup(patch.stop)

    def _rows(self):
        with open(os.path.join(self.root, "log.jsonl"), encoding="utf-8") as stream:
            return [json.loads(line) for line in stream]

    def test_b2_sim_attaches_memory_and_sends_human_line_in_working_layer(self):
        sim = self._sim()
        self.addCleanup(sim.director.wait)
        self.assertIsInstance(sim.director.memory, Memory)
        sim.human_say("remember the missing blue umbrella")
        sim.director.wait(timeout=1)
        self.assertFalse(sim.director.in_flight)
        self.assertTrue(sim.director.prompts)
        # The speech event alone is insufficient: the working memory must retain it.
        text, _ = sim.director.memory.build_prompt({})
        self.assertIn("remember the missing blue umbrella", text)
        self.assertIn("WORKING", sim.director.prompts[-1])

    def test_b4_queued_human_line_is_not_logged_as_playing(self):
        sim = self._sim()
        self._silence_director(sim)
        sim.npc_start("already speaking")
        self.now = 0.2
        sim.human_say("my queued line")
        human = [e for e in self._rows() if e.get("turn_owner") == "human"]
        self.assertFalse(any(e["type"] == "line" for e in human))
        self.assertTrue(any(e["type"] == "line_queued" for e in human))
        self.assertEqual(sim.active_line["owner"], "npc")

    def test_b4_human_playback_logs_actual_start_time_once(self):
        sim = self._sim()
        self._silence_director(sim)
        sim.npc_start("already speaking")
        self.now = 0.2
        sim.human_say("my queued line")
        self.now = 100.0
        sim._cycle_line()
        sim._cycle_line()
        human = [e for e in self._rows()
                 if e["type"] == "line" and e.get("turn_owner") == "human"]
        self.assertEqual(len(human), 1)
        self.assertEqual(human[0]["t"], 100.0)
        self.assertEqual(human[0]["text"], "my queued line")

    def test_b5_long_text_line_does_not_end_after_one_second(self):
        sim = self._sim()
        self._silence_director(sim)
        text = " ".join(["word"] * 20)
        sim.npc_start(text)
        sim.human_say("next")
        self.now = 1.01
        sim._cycle_line()
        self.assertEqual(sim.active_line, {"owner": "npc", "text": text})
        self.now = 20 / 2.5 + 1 + 0.01
        sim._cycle_line()
        self.assertEqual(sim.active_line["owner"], "human")

    def test_b5_text_duration_scales_with_speed_and_ignores_tags(self):
        sim = self._sim(speed=20)
        self._silence_director(sim)
        text = "[sigh] one two three four"
        sim.npc_start(text)
        sim.human_say("next")
        duration = (4 / 2.5 + 1) / 20
        self.now = duration - 0.001
        sim._cycle_line()
        self.assertEqual(sim.active_line["owner"], "npc")
        self.now = duration + 0.001
        sim._cycle_line()
        self.assertEqual(sim.active_line["owner"], "human")

    def test_b9_idle_human_plays_before_generated_npc_in_normal_run(self):
        sim = self._sim(speed=20)
        self._silence_director(sim)
        sim.human_say("human goes first")
        # Stop after exactly one normal run iteration, without wall-clock sleeps.
        def end_iteration(_seconds):
            sim.n_transitions = 1

        with mock.patch.object(sim.clock, "real_sleep", side_effect=end_iteration):
            sim.run(max_transitions=1, max_seconds=1)
        self.assertEqual(sim.active_line,
                         {"owner": "human", "text": "human goes first"})
        self.assertIsNone(sim.next_line)
        npc_lines = [e for e in self._rows()
                     if e["type"] == "line" and e.get("turn_owner") == "npc"]
        self.assertEqual(npc_lines, [])


class SimLifecycleTest(unittest.TestCase):
    setUp = SimOpenBugsTest.setUp
    _sim = SimOpenBugsTest._sim
    _silence_director = SimOpenBugsTest._silence_director
    _rows = SimOpenBugsTest._rows

    def test_transition_limit_stops_before_starting_another_consult(self):
        sim = self._sim()

        def finish_transition():
            sim.n_transitions = 1

        with mock.patch.object(sim, '_tick', side_effect=finish_transition), \
                mock.patch.object(sim, '_maybe_generate_line') as generate, \
                mock.patch.object(sim, '_maybe_consult') as consult:
            sim.run(max_transitions=1, max_seconds=1)
        generate.assert_not_called()
        consult.assert_not_called()

    def test_npc_is_remembered_only_when_it_starts(self):
        sim = self._sim()
        self._silence_director(sim)
        sim.npc_start('first played')
        sim.npc_start('discard this draft')
        sim.human_say('human accepted')
        self.assertEqual([x['text'] for x in sim.memory.lines],
                         ['first played', 'human accepted'])
        self.now = 100
        sim._cycle_line()
        self.assertEqual([x['text'] for x in sim.memory.lines].count('human accepted'), 1)
        self.assertNotIn('discard this draft', sim.memory.build_prompt({})[0])
        self.assertEqual(sim.line_count, 2)

    def test_context_waits_for_workers_before_removing_temporary_memory(self):
        with Sim(fake=True) as sim:
            root = sim.memory.root
            sim.human_say('remember until shutdown')
            self.assertTrue(os.path.isdir(root))
        self.assertFalse(sim.director.in_flight)
        self.assertFalse(os.path.exists(root))

    def test_queue_is_not_playback_and_discarded_npc_does_not_count(self):
        sim = self._sim()
        self._silence_director(sim)
        sim.human_say('human first')
        sim.npc_start('late generated draft')
        self.assertFalse(sim.playing)
        self.assertEqual(sim.line_count, 0)
        sim._cycle_line()
        self.assertTrue(sim.playing)
        self.assertEqual(sim.line_count, 1)

    def test_measured_audio_duration_controls_prepared_playback_slot(self):
        sim = self._sim(speed=20)
        self._silence_director(sim)
        sim.npc_start('first')
        sim.npc_start('prepared', audio_seconds=8)
        self.now = 1
        sim._cycle_line()
        self.assertEqual(sim.active_line['text'], 'prepared')
        sim.human_say('next')
        self.now = 1 + (8 + 0.4) / 20 - .001
        sim._cycle_line()
        self.assertEqual(sim.active_line['owner'], 'npc')
        self.now += .002
        sim._cycle_line()
        self.assertEqual(sim.active_line['owner'], 'human')

    def test_background_memory_failure_reaches_run_journal(self):
        sim = self._sim()
        sim.memory.save_episode_raw('a', 'one')
        sim.memory.save_episode_raw('b', 'two')
        with mock.patch('llm.call', side_effect=OSError('offline provider')):
            with self.assertLogs('memory', level='WARNING'):
                sim.memory.merge_background().join(1)
        rows = [row for row in self._rows() if row['type'] == 'memory_merge_fail']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['error'], 'offline provider')
        self.assertEqual(rows[0]['t'], self.now)

    def test_accepted_decision_updates_memory_but_invalid_one_does_not(self):
        from director import Director
        sim = self._sim()
        decision = dict(sim.script[0], facts_update=[{'op': 'ADD', 'fact': 'learned first fact'}])
        sim.director = Director(sim.fsm, memory=sim.memory, actors=sim.actors,
                                clock=sim.clock, script=[decision])
        sim.director.consult_async(self.now)
        sim.director.wait(1)
        sim.memory.wait(1)
        self.assertEqual(len(sim.memory.decisions), 1)
        self.assertIn('learned first fact', sim.memory.build_prompt({})[0])
        self.assertEqual(sim.memory.core['bridge'], decision['bridge'])
        sim._apply_transition()
        self.assertEqual(sim.memory.core['objects'], sim.scene['objects'])
        self.assertIsNone(sim.memory.core['bridge'])
        sim.director.script = [dict(decision, bridge='absent',
                                    facts_update=[{'op': 'ADD', 'fact': 'invalid fact'}])]
        sim.director._cur = 0
        sim.director.consult_async(self.now)
        sim.director.wait(1)
        self.assertEqual(len(sim.memory.decisions), 1)
        self.assertNotIn('invalid fact', sim.memory.build_prompt({})[0])


class ConcurrentJournalTest(unittest.TestCase):
    def test_workers_share_one_contiguous_jsonl_sequence(self):
        import threading
        from sim import Logger
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, 'log.jsonl')
            logger = Logger(path)
            workers = [threading.Thread(target=lambda: [logger.write_event(
                {'type': 'worker', 't': 1}) for _ in range(25)]) for _ in range(4)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(2)
                self.assertFalse(worker.is_alive())
            with open(path) as stream:
                rows = [json.loads(line) for line in stream]
            self.assertEqual([row['seq'] for row in rows], list(range(1, 101)))


if __name__ == "__main__":
    unittest.main()
