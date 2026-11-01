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

    def test_F1_dropped_consult_keeps_all_51_events_in_order(self):
        from director import Director
        from fsm import BuildFSM

        objects = ["clarinet", "lamp", "quilt", "radio", "chair"]
        fsm = BuildFSM(objects, voices={"old_woman"}, now=0.0)
        director = Director(fsm, delay=0.0)
        director._next_decision = lambda ticket, prompt: None  # dropped reply
        events = [{"source": "speech", "value": "line %d" % i} for i in range(51)]

        director.consult_async(0.0, events=events)
        director.wait()

        self.assertEqual([e["value"] for e in director.pending],
                         ["line %d" % i for i in range(51)])

        director._next_decision = lambda ticket, prompt: {}
        director.consult_async(1.0)
        director.wait()

        rows = director.prompts[-1].splitlines()
        self.assertEqual([r for r in rows if r.startswith("speech line ")],
                         ["speech line %d" % i for i in range(51)],
                         "the next prompt must carry all 51 events in their order")
