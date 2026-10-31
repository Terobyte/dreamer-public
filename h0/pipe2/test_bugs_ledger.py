"""Bug-proof tests for B18, B40, B41 (ledger resume caps, Spark pre-flight estimate,
event rows for image/GPU charges). Offline: the Spark transport is a fake."""

import json
import tempfile
import unittest
from pathlib import Path

from pipe2.ledger import Ledger

PRICES = {"spark": {"high": {"in": 1.0, "out": 10.0}, "max": None},
          "image": 0.04, "h100_s": 0.001}


def answer_body(text):
    return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 2000}}


class FakeTransport:
    def __init__(self):
        self.bodies = []

    def post(self, body, timeout):
        self.bodies.append(body)
        return answer_body("```json\n{}\n```")

    @property
    def calls(self):
        return len(self.bodies)


def event_rows(path):
    path = Path(path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


class TestB18ResumeFromBudgetCheckpoint(unittest.TestCase):
    def test_B18_resume_restores_a_fresh_cap_state_and_drops_dead_reserves(self):
        # Subtest 1: a run that hit its USD cap is resumed with a larger cap_usd.
        with self.subTest("capped run resumed with raised cap_usd"):
            path = Path(tempfile.mkdtemp()) / "events.jsonl"
            first = Ledger(path, PRICES, 1.0, 100)
            first.charge("spark", {"effort": "high", "in": 0, "out": 100_000})  # $1.0 spent
            self.assertFalse(first.allow("spark", 0.5))  # hits the cap, checkpoint says capped
            self.assertTrue(first.capped)

            resumed = Ledger(path, PRICES, 5.0, 100, resume=True)
            self.assertTrue(resumed.allow("spark", 0.5),
                            "resumed ledger with cap_usd=5.0 must allow a $0.5 call on $1.0 spent")

        # Subtest 2: a reservation taken by a process that died is not carried over.
        with self.subTest("tokens_reserved of a dead process"):
            path = Path(tempfile.mkdtemp()) / "events.jsonl"
            dead = Ledger(path, PRICES, 1000.0, 100, cap_tokens=1000)
            self.assertTrue(dead.allow("spark", 0.0, reserve_tokens=900))  # never settled

            resumed = Ledger(path, PRICES, 1000.0, 100, cap_tokens=1000, resume=True)
            self.assertEqual(resumed.tokens_reserved, 0)
            self.assertTrue(resumed.allow("spark", 0.0, reserve_tokens=500),
                            "a dead process's 900-token reserve must not block a 500-token call")


class TestB40SparkPreflightIncludesInput(unittest.TestCase):
    def test_B40_ask_estimate_counts_known_prompt_tokens(self):
        from pipe2.spark import Spark

        path = Path(tempfile.mkdtemp()) / "events.jsonl"
        # ~1,000,000 prompt tokens at $1/M input = $1.00 in; output ceiling 64000 at $10/M = $0.64.
        # Real estimate is ~$1.64, which must not fit under cap_usd=1.0.
        led = Ledger(path, PRICES, 1.0, 1000)
        transport = FakeTransport()
        spark = Spark(transport, led, clock=lambda: 0.0, sleep=lambda s: None)
        messages = [{"role": "user", "content": "x" * 3_000_000}]

        answer = spark.ask("builder", "hall", 1, messages, "high")

        self.assertEqual(answer.error, "cap")
        self.assertEqual(transport.calls, 0)


class TestB41ImageAndGpuChargesWriteEvents(unittest.TestCase):
    def test_B41_charge_image_and_h100_appends_an_event_row(self):
        path = Path(tempfile.mkdtemp()) / "events.jsonl"
        led = Ledger(path, PRICES, 100.0, 100)

        led.charge("image", 3)
        with self.subTest("image"):
            rows = event_rows(path)
            self.assertEqual(len(rows), 1, f"events.jsonl rows after charge('image', 3): {rows}")
            self.assertEqual(rows[0]["kind"], "image")
            self.assertAlmostEqual(rows[0]["cost_usd"], 0.12)

        led.charge("h100_s", 50)
        with self.subTest("h100_s"):
            rows = event_rows(path)
            self.assertEqual(len(rows), 2, f"events.jsonl rows after charge('h100_s', 50): {rows}")
            self.assertEqual(rows[1]["kind"], "h100_s")
            self.assertAlmostEqual(rows[1]["cost_usd"], 0.05)


if __name__ == "__main__":
    unittest.main()
