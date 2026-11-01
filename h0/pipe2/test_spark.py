"""Tests for the Spark client. Offline: the transport is always a fake."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from pipe2.ledger import Ledger
from pipe2.spark import Spark, TransportError, parse_scene

PRICES = {"spark": {"high": {"in": 1.0, "out": 10.0}}, "image": 0.04, "h100_s": 0.001}

SCENE = {"meta": {"name": "x"}, "rooms": []}


def answer_body(text, finish_reason="stop", usage=None):
    return {"choices": [{"message": {"content": text}, "finish_reason": finish_reason}],
            "usage": usage or {"prompt_tokens": 1000, "completion_tokens": 2000,
                               "completion_tokens_details": {"reasoning_tokens": 500}}}


class FakeTransport:
    """Returns (or raises) one queued item per post; records every body it saw."""

    def __init__(self, *queue):
        self.queue = list(queue)
        self.bodies = []

    def post(self, body, timeout):
        self.bodies.append(body)
        item = self.queue.pop(0) if self.queue else answer_body("```json\n{}\n```")
        if isinstance(item, BaseException):
            raise item
        return item

    @property
    def calls(self):
        return len(self.bodies)


def spark(*queue, cap_usd=1000.0, cap_calls=1000, prices=None):
    path = Path(tempfile.mkdtemp()) / "events.jsonl"
    led = Ledger(path, prices if prices is not None else PRICES, cap_usd, cap_calls)
    transport = FakeTransport(*queue)
    slept = []
    return Spark(transport, led, clock=iter_clock(), sleep=slept.append), transport, led, slept


def iter_clock():
    state = {"t": 0.0}

    def clock():
        state["t"] += 1.5
        return state["t"]

    return clock


MSGS = [{"role": "user", "content": "hi"}]


class TestBody(unittest.TestCase):
    def test_body_carries_max_tokens_model_and_effort(self):
        sp, tr, _, _ = spark(answer_body("```json\n" + json.dumps(SCENE) + "\n```"))
        ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
        body = tr.bodies[0]
        self.assertEqual(body["max_tokens"], 64000)
        self.assertEqual(body["reasoning_effort"], "high")
        self.assertEqual(body["model"], "muse-spark-1.3-contributor")
        self.assertEqual(body["messages"], MSGS)
        self.assertTrue(ans.valid)
        self.assertEqual(ans.scene, SCENE)


class TestRetries(unittest.TestCase):
    def test_retryable_failures_are_retried_at_most_twice(self):
        for err in (TransportError("rate", 429, True), TransportError("boom", 503, True),
                    TransportError("reset", None, True)):
            with self.subTest(status=err.status):
                sp, tr, _, slept = spark(err, err, err)
                ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
                self.assertEqual(tr.calls, 3)
                self.assertFalse(ans.valid)
                self.assertIn("transport", ans.error)
                self.assertEqual(len(slept), 2)
                self.assertTrue(20 <= slept[0] <= 25 and 40 <= slept[1] <= 45, slept)

    def test_retry_then_success(self):
        sp, tr, _, _ = spark(TransportError("rate", 429, True),
                             answer_body("```json\n" + json.dumps(SCENE) + "\n```"))
        ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
        self.assertEqual(tr.calls, 2)
        self.assertTrue(ans.valid)

    def test_non_retryable_4xx_is_not_retried(self):
        sp, tr, _, slept = spark(TransportError("bad request", 400, False))
        ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
        self.assertEqual(tr.calls, 1)
        self.assertEqual(slept, [])
        self.assertFalse(ans.valid)


class TestBadAnswers(unittest.TestCase):
    def test_bad_answers_are_invalid_without_raising(self):
        cases = {
            "length": answer_body("```json\n{\"a\": 1}\n```", finish_reason="length"),
            "no_json": answer_body("sorry, I cannot do that"),
            "truncated": answer_body("```json\n{\"rooms\": [{\"id\": \"kit"),
        }
        for name, body in cases.items():
            with self.subTest(case=name):
                sp, _, _, _ = spark(body)
                ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
                self.assertFalse(ans.valid)
                self.assertTrue(ans.error)
                self.assertIsNone(ans.scene)

    def test_parse_scene_takes_the_last_json_block(self):
        text = "```json\n{\"a\": 1}\n```\nand then\n```json\n{\"b\": 2}\n```"
        self.assertEqual(parse_scene(text), {"b": 2})
        self.assertEqual(parse_scene("prose {\"c\": 3} tail"), {"c": 3})
        with self.assertRaises(ValueError):
            parse_scene("no json here")


class TestEvents(unittest.TestCase):
    def test_every_call_writes_one_event_with_cost_from_prices(self):
        sp, _, led, _ = spark(answer_body("```json\n" + json.dumps(SCENE) + "\n```"))
        sp.ask("builder", "kitchen", 3, MSGS, "high")
        lines = led.path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        ev = json.loads(lines[0])
        self.assertEqual(ev["kind"], "spark")
        self.assertEqual((ev["role"], ev["room"], ev["round"]), ("builder", "kitchen", 3))
        self.assertEqual(ev["prompt_tokens"], 1000)
        self.assertEqual(ev["completion_tokens"], 2000)
        self.assertEqual(ev["reasoning_tokens"], 500)
        self.assertEqual(ev["finish_reason"], "stop")
        self.assertTrue(ev["valid"])
        self.assertAlmostEqual(ev["cost_usd"], 1000 / 1e6 * 1.0 + 2000 / 1e6 * 10.0)
        self.assertGreater(ev["latency_s"], 0)

    def test_failed_calls_are_recorded_too(self):
        sp, _, led, _ = spark(TransportError("bad request", 400, False))
        sp.ask("builder", "kitchen", 1, MSGS, "high")
        ev = json.loads(led.path.read_text(encoding="utf-8").splitlines()[0])
        self.assertFalse(ev["valid"])


class TestCapStopsCleanly(unittest.TestCase):
    def test_cap_stops_cleanly(self):
        ok = answer_body("```json\n" + json.dumps(SCENE) + "\n```")
        sp, tr, led, _ = spark(ok, ok, ok, cap_calls=1)
        self.assertTrue(sp.ask("builder", "kitchen", 1, MSGS, "high").valid)
        for _ in range(2):
            ans = sp.ask("builder", "kitchen", 2, MSGS, "high")
            self.assertFalse(ans.valid)
            self.assertEqual(ans.error, "cap")
        self.assertEqual(tr.calls, 1)
        kinds = [json.loads(l)["kind"] for l in led.path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(kinds.count("cap_hit"), 1)


class TestKeyNotLeaked(unittest.TestCase):
    def test_key_not_leaked(self):
        key = "sk-fake-pipe2-7f3a9"
        old = os.environ.get("META_MODEL_API_KEY")
        os.environ["META_MODEL_API_KEY"] = key
        try:
            sp, _, led, _ = spark(answer_body("```json\n" + json.dumps(SCENE) + "\n```"),
                                  TransportError("bad request", 400, False))
            answers = [sp.ask("builder", "kitchen", 1, MSGS, "high"),
                       sp.ask("critic", "kitchen", 2, MSGS, "high")]
            text = led.path.read_text(encoding="utf-8")
            self.assertNotIn(key, text)
            for ans in answers:
                self.assertNotIn(key, repr(ans))
                self.assertNotIn(key, str(ans))
        finally:
            if old is None:
                del os.environ["META_MODEL_API_KEY"]
            else:
                os.environ["META_MODEL_API_KEY"] = old


class TestHttpTransportFailureScope(unittest.TestCase):
    def test_malformed_200_body_makes_a_single_request(self):
        import urllib.request
        from pipe2.spark import HttpTransport
        attempts = []

        class BadBody:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b"not json"

        real_urlopen = urllib.request.urlopen
        urllib.request.urlopen = lambda req, timeout=None: (attempts.append(1), BadBody())[1]
        key = "sk-fake-pipe2-7f3a9"
        old = os.environ.get("META_MODEL_API_KEY")
        os.environ["META_MODEL_API_KEY"] = key
        try:
            path = Path(tempfile.mkdtemp()) / "events.jsonl"
            led = Ledger(path, PRICES, 1000.0, 1000)
            slept = []
            sp = Spark(HttpTransport(), led, clock=iter_clock(), sleep=slept.append)
            ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
            self.assertEqual(len(attempts), 1)
            self.assertEqual(slept, [])
            self.assertFalse(ans.valid)
            self.assertNotIn(key, led.path.read_text(encoding="utf-8"))
        finally:
            urllib.request.urlopen = real_urlopen
            if old is None:
                del os.environ["META_MODEL_API_KEY"]
            else:
                os.environ["META_MODEL_API_KEY"] = old


class TestHttpTransportRetryScope(unittest.TestCase):
    def test_value_error_from_urlopen_is_not_retried(self):
        import urllib.request
        from pipe2.spark import HttpTransport
        attempts = []
        real_urlopen = urllib.request.urlopen

        def boom(req, timeout=None):
            attempts.append(1)
            raise ValueError("boom")

        urllib.request.urlopen = boom
        old = os.environ.get("META_MODEL_API_KEY")
        os.environ["META_MODEL_API_KEY"] = "sk-fake-pipe2-7f3a9"
        try:
            path = Path(tempfile.mkdtemp()) / "events.jsonl"
            led = Ledger(path, PRICES, 1000.0, 1000)
            slept = []
            sp = Spark(HttpTransport(), led, clock=iter_clock(), sleep=slept.append)
            ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
            self.assertEqual(len(attempts), 1)
            self.assertEqual(slept, [])
            self.assertFalse(ans.valid)
        finally:
            urllib.request.urlopen = real_urlopen
            if old is None:
                del os.environ["META_MODEL_API_KEY"]
            else:
                os.environ["META_MODEL_API_KEY"] = old


class TestHttpTransportKeySource(unittest.TestCase):
    def test_key_source_is_fixed_env(self):
        import inspect
        from pipe2.spark import HttpTransport
        self.assertNotIn("key_env", inspect.signature(HttpTransport.__init__).parameters)


class TestHttpTransportUrlIsFixed(unittest.TestCase):
    def test_url_is_not_caller_configurable(self):
        import inspect
        from pipe2.spark import HttpTransport
        self.assertNotIn("url", inspect.signature(HttpTransport.__init__).parameters)

    def test_post_always_targets_the_meta_endpoint(self):
        import urllib.request
        from pipe2.spark import URL, HttpTransport

        class OkBody:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'{"choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}], "usage": {}}'

        seen = []
        real_urlopen = urllib.request.urlopen
        urllib.request.urlopen = lambda req, timeout=None: (seen.append(req.full_url), OkBody())[1]
        old = os.environ.get("META_MODEL_API_KEY")
        os.environ["META_MODEL_API_KEY"] = "sk-fake-pipe2-7f3a9"
        try:
            HttpTransport().post({}, 1.0)
            self.assertEqual(seen, [URL])
        finally:
            urllib.request.urlopen = real_urlopen
            if old is None:
                del os.environ["META_MODEL_API_KEY"]
            else:
                os.environ["META_MODEL_API_KEY"] = old


class TestHttpTransportRetryScopeNarrow(unittest.TestCase):
    def test_generic_url_error_is_not_retried(self):
        import urllib.error
        import urllib.request
        from pipe2.spark import HttpTransport
        attempts = []

        def boom(req, timeout=None):
            attempts.append(1)
            raise urllib.error.URLError("unknown url type: 'ftp'")

        real_urlopen = urllib.request.urlopen
        urllib.request.urlopen = boom
        old = os.environ.get("META_MODEL_API_KEY")
        os.environ["META_MODEL_API_KEY"] = "sk-fake-pipe2-7f3a9"
        try:
            path = Path(tempfile.mkdtemp()) / "events.jsonl"
            led = Ledger(path, PRICES, 1000.0, 1000)
            slept = []
            sp = Spark(HttpTransport(), led, clock=iter_clock(), sleep=slept.append)
            ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
            self.assertEqual(len(attempts), 1)
            self.assertEqual(slept, [])
            self.assertFalse(ans.valid)
        finally:
            urllib.request.urlopen = real_urlopen
            if old is None:
                del os.environ["META_MODEL_API_KEY"]
            else:
                os.environ["META_MODEL_API_KEY"] = old

    def test_incomplete_read_is_retried(self):
        import http.client
        import urllib.request
        from pipe2.spark import HttpTransport
        attempts = []

        class BrokenBody:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                raise http.client.IncompleteRead(b"partial")

        real_urlopen = urllib.request.urlopen
        urllib.request.urlopen = lambda req, timeout=None: (attempts.append(1), BrokenBody())[1]
        old = os.environ.get("META_MODEL_API_KEY")
        os.environ["META_MODEL_API_KEY"] = "sk-fake-pipe2-7f3a9"
        try:
            path = Path(tempfile.mkdtemp()) / "events.jsonl"
            led = Ledger(path, PRICES, 1000.0, 1000)
            slept = []
            sp = Spark(HttpTransport(), led, clock=iter_clock(), sleep=slept.append)
            ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
            self.assertEqual(len(attempts), 3)
            self.assertEqual(len(slept), 2)
            self.assertFalse(ans.valid)
        finally:
            urllib.request.urlopen = real_urlopen
            if old is None:
                del os.environ["META_MODEL_API_KEY"]
            else:
                os.environ["META_MODEL_API_KEY"] = old

    def test_url_error_wrapping_a_timeout_is_retried(self):
        import socket
        import urllib.error
        import urllib.request
        from pipe2.spark import HttpTransport
        attempts = []

        def boom(req, timeout=None):
            attempts.append(1)
            raise urllib.error.URLError(socket.timeout("timed out"))

        real_urlopen = urllib.request.urlopen
        urllib.request.urlopen = boom
        old = os.environ.get("META_MODEL_API_KEY")
        os.environ["META_MODEL_API_KEY"] = "sk-fake-pipe2-7f3a9"
        try:
            path = Path(tempfile.mkdtemp()) / "events.jsonl"
            led = Ledger(path, PRICES, 1000.0, 1000)
            slept = []
            sp = Spark(HttpTransport(), led, clock=iter_clock(), sleep=slept.append)
            ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
            self.assertEqual(len(attempts), 3)
            self.assertEqual(len(slept), 2)
            self.assertFalse(ans.valid)
        finally:
            urllib.request.urlopen = real_urlopen
            if old is None:
                del os.environ["META_MODEL_API_KEY"]
            else:
                os.environ["META_MODEL_API_KEY"] = old


class SpyLedger(Ledger):
    """Records what Spark reserved and settled, without changing the accounting."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reserves = []
        self.settles = []

    def allow(self, kind, estimate_usd, reserve_tokens=0):
        granted = super().allow(kind, estimate_usd, reserve_tokens=reserve_tokens)
        self.reserves.append((reserve_tokens, granted))
        return granted

    def settle(self, reserve_tokens, actual_tokens):
        self.settles.append((reserve_tokens, actual_tokens))
        return super().settle(reserve_tokens, actual_tokens)


def spy_spark(*queue, cap_tokens=None, cap_usd=1000.0, cap_calls=1000):
    path = Path(tempfile.mkdtemp()) / "events.jsonl"
    led = SpyLedger(path, PRICES, cap_usd, cap_calls, cap_tokens=cap_tokens)
    transport = FakeTransport(*queue)
    return Spark(transport, led, clock=iter_clock(), sleep=lambda _s: None), transport, led


def image_msgs(payload):
    return [{"role": "system", "content": "a" * 30},
            {"role": "user", "content": [{"type": "text", "text": "b" * 9},
                                         {"type": "image_url",
                                          "image_url": {"url": "data:image/png;base64," + payload}}]}]


class TestTokenReserve(unittest.TestCase):
    OK = staticmethod(lambda: answer_body("```json\n" + json.dumps(SCENE) + "\n```"))

    def test_reserve_follows_the_contract_formula(self):
        sp, _, led = spy_spark(self.OK())
        msgs = image_msgs("Z" * 64)
        self.assertTrue(sp.ask("builder", "kitchen", 1, msgs, "high").valid)
        self.assertEqual(led.reserves, [(39 // 3 + 1500 + 64000, True)])

    def test_one_megabyte_image_does_not_inflate_the_reserve(self):
        sp, _, led = spy_spark(self.OK())
        msgs = image_msgs("Z" * (1024 * 1024))
        sp.ask("builder", "kitchen", 1, msgs, "high")
        reserve = led.reserves[0][0]
        self.assertLessEqual(reserve, 64000 + 1500 + 39 // 3)

    def test_settle_runs_once_per_ask_even_with_retries(self):
        sp, tr, led = spy_spark(TransportError("rate", 429, True), TransportError("rate", 429, True),
                                self.OK())
        sp.ask("builder", "kitchen", 1, MSGS, "high")
        self.assertEqual(tr.calls, 3)
        self.assertEqual(len(led.reserves), 1)
        self.assertEqual(led.settles, [(64000, 3000)])
        self.assertEqual(led.tokens_reserved, 0)
        self.assertEqual(led.tokens_used, 3000)

    def test_settle_runs_once_for_an_invalid_answer(self):
        sp, _, led = spy_spark(answer_body("no json here", finish_reason="length"))
        self.assertFalse(sp.ask("builder", "kitchen", 1, MSGS, "high").valid)
        self.assertEqual(led.settles, [(64000, 3000)])

    def test_without_usage_the_reserve_is_charged_as_actual(self):
        sp, _, led = spy_spark(TransportError("bad request", 400, False))
        sp.ask("builder", "kitchen", 1, MSGS, "high")
        self.assertEqual(led.settles, [(64000, 64000)])

    def test_token_cap_below_the_reserve_refuses_without_calling_out(self):
        sp, tr, led = spy_spark(self.OK(), cap_tokens=1000)
        ans = sp.ask("builder", "kitchen", 1, MSGS, "high")
        self.assertFalse(ans.valid)
        self.assertEqual(ans.error, "cap")
        self.assertEqual(tr.calls, 0)
        self.assertEqual(led.settles, [])
        self.assertEqual(led.tokens_reserved, 0)


if __name__ == "__main__":
    unittest.main()
