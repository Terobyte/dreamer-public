"""Tests for the cost/event ledger. Offline, no engine, no network."""

import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from pipe2.ledger import Ledger, load_prices

PRICES = {
    "spark": {"high": {"in": 1.0, "out": 10.0}, "max": None},
    "image": 0.04,
    "h100_s": 0.001,
}


def ledger(cap_usd=100.0, cap_calls=100, prices=None):
    path = Path(tempfile.mkdtemp()) / "events.jsonl"
    return Ledger(path, prices if prices is not None else PRICES, cap_usd, cap_calls)


class TestPricesFile(unittest.TestCase):
    def test_shipped_prices_have_the_contract_shape(self):
        prices = load_prices()
        self.assertIn("spark", prices)
        self.assertIn("image", prices)
        self.assertIn("h100_s", prices)
        for effort, price in prices["spark"].items():
            if price is not None:
                self.assertIn("in", price, effort)
                self.assertIn("out", price, effort)


class TestRecord(unittest.TestCase):
    def test_record_appends_one_json_line_per_event_with_contract_fields(self):
        led = ledger()
        led.record({"kind": "ask", "role": "builder", "room": "kitchen", "round": 2,
                    "effort": "high", "latency_s": 1.5, "prompt_tokens": 10,
                    "completion_tokens": 20, "finish_reason": "stop", "valid": True,
                    "cost_usd": 0.5})
        led.record({"kind": "ask", "role": "critic", "room": "hall", "round": 1})
        lines = led.path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        first = json.loads(lines[0])
        for field in ("ts", "kind", "role", "room", "round", "effort", "latency_s",
                      "prompt_tokens", "completion_tokens", "reasoning_tokens",
                      "finish_reason", "valid", "cost_usd"):
            self.assertIn(field, first)
        self.assertEqual(first["room"], "kitchen")
        self.assertIsNone(json.loads(lines[1])["effort"])


class TestCharge(unittest.TestCase):
    def test_spark_cost_is_computed_from_prices_per_million_tokens(self):
        led = ledger()
        cost = led.charge("spark", {"effort": "high", "in": 1_000_000, "out": 100_000})
        self.assertAlmostEqual(cost, 1.0 + 1.0)
        self.assertAlmostEqual(led.spent, 2.0)

    def test_unknown_spark_price_is_free_but_calls_still_counted(self):
        led = ledger(cap_calls=1)
        self.assertAlmostEqual(led.charge("spark", {"effort": "max", "in": 9_000_000, "out": 9_000_000}), 0.0)
        self.assertAlmostEqual(led.spent, 0.0)
        self.assertTrue(led.allow("spark", 0.0))
        self.assertFalse(led.allow("spark", 0.0))

    def test_image_and_gpu_seconds(self):
        led = ledger()
        self.assertAlmostEqual(led.charge("image", 3), 0.12)
        self.assertAlmostEqual(led.charge("h100_s", 50), 0.05)
        self.assertAlmostEqual(led.spent, 0.17)


class TestCap(unittest.TestCase):
    def test_allow_blocks_when_estimate_would_pass_the_usd_cap(self):
        led = ledger(cap_usd=1.0)
        self.assertTrue(led.allow("spark", 0.5))
        led.charge("spark", {"effort": "high", "in": 0, "out": 100_000})  # $1.0
        self.assertFalse(led.allow("spark", 0.5))

    def test_allow_blocks_when_call_cap_is_reached(self):
        led = ledger(cap_calls=2)
        self.assertTrue(led.allow("spark", 0.0))
        self.assertTrue(led.allow("spark", 0.0))
        self.assertFalse(led.allow("spark", 0.0))

    def test_cap_hit_event_is_written_once(self):
        led = ledger(cap_usd=0.0)
        for _ in range(3):
            self.assertFalse(led.allow("spark", 1.0))
        kinds = [json.loads(l)["kind"] for l in led.path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(kinds.count("cap_hit"), 1)


class TestConcurrentCap(unittest.TestCase):
    def test_concurrent_allow_admits_only_up_to_call_cap(self):
        led = ledger(cap_usd=100.0, cap_calls=1)

        class Gate(int):
            # Forces both threads to evaluate the cap check against the same
            # counter value. Without serialization both get admitted.
            def __ge__(self, other):
                time.sleep(0.02)
                return int(self) >= other

        led.calls = Gate(0)
        results = []
        threads = [threading.Thread(target=lambda: results.append(led.allow("spark", 0.0)))
                   for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(int(led.calls), 1)


class TestConcurrentSpend(unittest.TestCase):
    def test_allow_reserves_the_estimate_so_concurrent_calls_cannot_exceed_cap(self):
        led = ledger(cap_usd=1.0, cap_calls=10)
        results = []
        threads = [threading.Thread(target=lambda: results.append(led.allow("spark", 0.6)))
                   for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(sorted(results), [False, True])
        self.assertLessEqual(led.spent, led.cap_usd)

    def test_charge_releases_the_matching_reservation(self):
        led = ledger(cap_usd=100.0)
        self.assertTrue(led.allow("spark", 0.6))
        cost = led.charge("spark", {"effort": "high", "in": 0, "out": 100_000}, reserved=0.6)  # $1.0
        self.assertAlmostEqual(cost, 1.0)
        self.assertAlmostEqual(led.spent, 1.0)


if __name__ == "__main__":
    unittest.main()
