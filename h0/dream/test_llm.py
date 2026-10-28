"""Offline contract tests for llm wrapper rules (spec sections 6, 13).
usage: cd h0/dream && python3 -m unittest -q
"""

import json
import os
import unittest
from unittest import mock

import llm
from fake import FakeTransport


def _msgs():
    return [{"role": "user", "content": "hi"}]


class LlmRulesTest(unittest.TestCase):
    def test_retry_empty_with_bigger_limit(self):
        tr = FakeTransport(script=["", "clarinet bridge"])
        llm.reset_spent()
        r = llm.call("director", "sys", _msgs(), max_tokens=500,
                     fake=True, _transport=tr)
        self.assertEqual(r.text, "clarinet bridge")
        self.assertEqual(tr.calls, 2)
        self.assertGreater(tr.sent[1]["max_tokens"], tr.sent[0]["max_tokens"])

    def test_spark_floor_300(self):
        tr = FakeTransport(script=["hero line"])
        llm.reset_spent()
        llm.call("hero", "sys", _msgs(), max_tokens=120,
                 fake=True, _transport=tr)
        # hero is Spark Open now: its floor is higher, Spark 1.3 keeps 300
        self.assertGreaterEqual(tr.sent[0]["max_tokens"], 1500)
        self.assertEqual(tr.sent[0]["max_tokens"], 1500)
        self.assertEqual(llm._min_tokens(llm.SPARK_MODEL), 300)

    def test_talk_model_knob(self):
        try:
            llm.set_talk_model("wonder")
            for role in llm.TALK_ROLES:
                self.assertEqual(llm.resolve(role), (llm.WONDER_MODEL, "low"))
            self.assertEqual(llm.resolve("director"), (llm.WONDER_MODEL, "low"))
            with self.assertRaises(ValueError):
                llm.set_talk_model("gpt")
        finally:
            llm.set_talk_model("spark-open")
        self.assertEqual(llm.resolve("hero"), (llm.SPARK_OPEN_MODEL, "minimal"))

    def test_cap_stops_paid_calls_only(self):
        llm.reset_spent()
        try:
            llm.set_cap(0.0)
            paid = FakeTransport(script=["a"])
            r = llm.call("director", "sys", _msgs(), max_tokens=300, fake=True, _transport=paid)
            self.assertEqual(r.text, "")
            self.assertEqual(paid.sent, [])
            self.assertEqual([d["type"] for d in r.diagnostics], ["cap"])
            free = FakeTransport(script=["b"])
            r = llm.call("hero", "sys", _msgs(), max_tokens=300, fake=True, _transport=free)
            self.assertEqual(r.text, "b")
        finally:
            llm.set_cap(None)

    def test_spark_never_low(self):
        for role in ("hero", "actor", "compress", "judge"):
            model, effort = llm.resolve(role)
            self.assertEqual(model, "meta-models/muse-spark-open-1026")
            self.assertNotEqual(effort, "low")

    def test_money_sums(self):
        llm.reset_spent()
        t1 = FakeTransport(script=["a"])
        r1 = llm.call("hero", "sys", _msgs(), max_tokens=300,
                      fake=True, _transport=t1)
        t2 = FakeTransport(script=["a" * 100, "b" * 100])
        r2 = llm.call("director", "sys", _msgs(), max_tokens=500,
                      fake=True, _transport=t2)
        self.assertEqual(r1.dollars, 0)  # Spark Open on Baseten is free
        self.assertGreater(r2.dollars, 0)
        self.assertAlmostEqual(llm.get_spent(), r1.dollars + r2.dollars)

    def test_money_covers_fish_and_image(self):
        llm.reset_spent()
        t1 = FakeTransport(script=["a"])
        r1 = llm.call("hero", "sys", _msgs(), max_tokens=300,
                      fake=True, _transport=t1)
        fish = llm.charge_fish(1000)
        img = llm.charge_image(1)
        self.assertGreater(fish, 0)
        self.assertGreater(img, 0)
        self.assertAlmostEqual(llm.get_spent(),
                               r1.dollars + fish + img)


class FallbackDiagnosticsTest(unittest.TestCase):
    """B3/B6: a paid fallback must retain and report the provider failure."""

    def setUp(self):
        self.previous_spent = llm.get_spent()
        self.addCleanup(llm._spent.__setitem__, 0, self.previous_spent)
        llm.reset_spent()
        self.post = self.enterContext(mock.patch.object(llm, "_post", side_effect=self._post))
        self.enterContext(mock.patch.object(llm, "_baseten_key", return_value="test-key"))
        self.enterContext(mock.patch.dict(os.environ, {"META_MODEL_API_KEY": "test-key"}))
        # Even an accidental bypass of _post cannot reach the network.
        self.enterContext(mock.patch.object(llm.urllib.request, "urlopen",
                                           side_effect=AssertionError("network forbidden")))

    def _post(self, url, *args):
        if url == llm.BASETEN_API:
            raise OSError("baseten unavailable: 503")
        self.assertEqual(url, llm.META_API)
        return {"content": "fallback reply",
                "usage": {"prompt_tokens": 100, "completion_tokens": 10}}

    def test_b3_result_retains_fallback_reason(self):
        result = llm.call("hero", "system", _msgs())
        self.assertEqual(result.text, "fallback reply")
        self.assertEqual(self.post.call_count, 2)
        self.assertGreater(result.dollars, 0)
        # No prescribed metadata field name: the reason must survive in the result.
        self.assertIn("baseten unavailable: 503", json.dumps(vars(result)))

    def test_b6_baseten_failure_is_logged(self):
        with self.assertLogs(level="WARNING") as captured:
            result = llm.call("hero", "system", _msgs())
        self.assertEqual(result.text, "fallback reply")
        self.assertIn("baseten unavailable: 503", "\n".join(captured.output))

    def test_fallback_attempt_identifies_billed_model_and_reaches_event_sink(self):
        events = []
        with self.assertLogs("llm", level="WARNING"):
            result = llm.call("compress", "system", _msgs(), event_sink=events.append)
        self.assertEqual(events, result.diagnostics)
        self.assertEqual(events[0]["from_model"], llm.SPARK_OPEN_MODEL)
        self.assertEqual(events[0]["to_model"], llm.SPARK_MODEL)
        self.assertEqual(result.attempts[0]["model"], llm.SPARK_MODEL)
        self.assertAlmostEqual(result.attempts[0]["dollars"], result.dollars)

    def test_fallback_reason_survives_when_both_providers_fail(self):
        events = []
        self.post.side_effect = OSError("both providers unavailable")
        with self.assertLogs("llm", level="WARNING"):
            with self.assertRaisesRegex(OSError, "both providers unavailable"):
                llm.call("compress", "system", _msgs(), event_sink=events.append)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "llm_fallback")
        self.assertEqual(llm.get_spent(), 0)


if __name__ == "__main__":
    unittest.main()
