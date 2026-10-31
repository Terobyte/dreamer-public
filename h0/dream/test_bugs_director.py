"""Regression tests for director bugs in bugs.md."""
import unittest


class FailedConsultKeepsEventsTest(unittest.TestCase):
    def test_B48_human_says_survives_failed_consult(self):
        from director import Director
        from fsm import BuildFSM

        objects = ["clarinet", "lamp", "quilt", "radio", "chair"]
        fsm = BuildFSM(objects, voices={"old_woman"}, now=0.0)
        director = Director(fsm, delay=0.0)
        answers = iter([None, {}])
        director._next_decision = lambda ticket, prompt: next(answers)
        human_says = "I found the blue key under the piano"

        director.consult_async(0.0, events=[{"source": "speech", "value": human_says}])
        director.wait()
        director.consult_async(1.0)
        director.wait()

        self.assertIn(human_says, director.prompts[-1])
