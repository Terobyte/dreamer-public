"""Regression tests for B50: pre-generate NPC turns during playback."""
import tempfile
import threading
import unittest

import sim as S


class Dialogue:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()

    def actor_line(self, *args):
        self.entered.set()
        self.release.wait(5)
        return {"role": "actor", "who": "Squidward", "text": "Next line."}


class TurnPrefetchBugTests(unittest.TestCase):
    def make_sim(self, dialogue):
        sim = S.Sim(profile="A", fake=True, outdir=tempfile.mkdtemp(), dialogue=dialogue)
        self.addCleanup(sim.close)
        sim.actors = ["Squidward"]
        sim._pick_speaker = lambda: ("Squidward", "actor")
        sim.fsm.awake = False
        return sim

    def wait_result(self, sim, dialogue):
        self.assertTrue(dialogue.entered.wait(3), "B50: next NPC generation waits for the active line to end")
        dialogue.release.set()
        worker = sim._gen_thread
        worker.join(3)
        self.assertFalse(worker.is_alive(), "B50: scripted generation worker did not finish")
        sim._maybe_generate_line()

    def test_B50_generation_starts_while_current_line_is_active(self):
        dialogue = Dialogue()
        sim = self.make_sim(dialogue)
        sim._start_line({"owner": "npc", "text": "Current line."})
        sim._last_tick = -1e9
        sim._maybe_generate_line()
        self.assertTrue(dialogue.entered.wait(3),
                        "B50: next NPC generation waits for the active line to end")
        dialogue.release.set()

    def test_B50_prepared_line_starts_on_first_tick_after_current_ends(self):
        sim = self.make_sim(Dialogue())
        sim.active_line = {"owner": "npc", "text": "Current line."}
        sim._line_started_at = sim.clock.now() - 100
        sim._line_duration = 0
        sim.prepared_npc = "Next line."
        sim._prepared_meta = {"who": "Squidward", "role": "actor"}
        sim._cycle_line()
        self.assertEqual(sim.active_line["text"], "Next line.",
                         "B50: prepared next line did not start on the first post-end tick")

    def test_B50_human_replacement_returns_prepared_turn_events(self):
        dialogue = Dialogue()
        sim = self.make_sim(dialogue)
        event = {"kind": "story", "what": "the radio rings"}
        sim._pending["Squidward"] = [event]
        sim._maybe_generate_line()
        self.assertTrue(dialogue.entered.wait(3), "B50: scripted event turn did not start")
        # Playback begins while the worker is in flight; the result must queue behind it.
        sim.active_line = {"owner": "npc", "text": "Current line."}
        dialogue.release.set()
        sim._gen_thread.join(3)
        self.assertFalse(sim._gen_thread.is_alive(), "B50: scripted generation worker did not finish")
        sim._maybe_generate_line()
        self.assertEqual(sim.prepared_npc, "Next line.", "B50: result was not prepared behind playback")
        sim.human_say("My turn.")
        self.assertEqual(sim._pending.get("Squidward", []), [event],
                         "B50: human replacement dropped the prepared line but lost its taken events")
        self.assertIsNone(sim.prepared_npc, "B50: human line must replace the prepared NPC line")



if __name__ == "__main__":
    unittest.main()
