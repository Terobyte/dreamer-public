# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
"""B45: the retry cap check prices the paid model that answered, not the role's free one.

The hunter's repro billed 1.17M completion tokens for max_tokens=50, which no provider
does; the claim itself holds with honest numbers: the free primary prices the retry at
$0, the paid fallback that answered the first attempt does not."""
import unittest
from unittest import mock

import llm


class T:
    def __init__(self):
        self.calls = 0

    def complete(self, model, effort, system, messages, max_tokens, **kw):
        self.calls += 1
        # Baseten failed, the paid Meta model answered with an empty reply at the full limit
        return {"content": "", "model": llm.SPARK_MODEL,
                "usage": {"prompt_tokens": 4000, "completion_tokens": max_tokens}}


class B45(unittest.TestCase):
    def _run(self, cap_after_first):
        spent = {"v": 0.0}
        model, _ = llm.resolve("hero")
        self.assertEqual(llm._price(model, 1, 1), 0.0, "fixture: hero's primary model is free")
        first = llm._price(llm.SPARK_MODEL, 4000, max(50, llm._min_tokens(model)))
        t = T()
        with mock.patch.object(llm, "get_spent", lambda: spent["v"]), \
                mock.patch.object(llm, "_charge", lambda d: spent.__setitem__("v", spent["v"] + d)), \
                mock.patch.object(llm, "_cap", [first + cap_after_first]):
            res = llm.call("hero", "sys", [{"role": "user", "content": "hi"}], max_tokens=50,
                           _transport=t)
        return t, spent["v"], first + cap_after_first, res

    def test_paid_fallback_retry_respects_cap(self):
        t, spent, cap, res = self._run(1e-6)  # a hair of budget left after the first attempt
        self.assertEqual(t.calls, 1, "retry on paid fallback not skipped: calls=%d spent=%.6f cap=%.6f"
                         % (t.calls, spent, cap))
        self.assertLessEqual(spent, cap + 1e-9)
        self.assertTrue(any(d.get("type") == "cap" for d in res.diagnostics))

    def test_retry_runs_when_the_budget_covers_it(self):
        t, spent, cap, _ = self._run(1.0)
        self.assertEqual(t.calls, 2)


if __name__ == "__main__":
    unittest.main()
