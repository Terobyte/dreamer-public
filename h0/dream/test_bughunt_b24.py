# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
import pytest
import llm


class FakeTransport:
    def __init__(self):
        self.calls = []

    def complete(self, model, effort, system, messages, max_tokens, **kw):
        self.calls.append(max_tokens)
        if len(self.calls) == 1:
            return {"content": "", "usage": {"prompt_tokens": 10, "completion_tokens": 5}, "model": model}
        return {"content": "hello", "usage": {"prompt_tokens": 10, "completion_tokens": 5}, "model": model}


def test_retry_respects_cap(monkeypatch):
    # force a paid model and fixed positive price per attempt
    monkeypatch.setattr(llm, "resolve", lambda role: ("paid-model-x", "minimal"))
    monkeypatch.setattr(llm, "_min_tokens", lambda model: 10)
    monkeypatch.setattr(llm, "_price", lambda model, p, c: 5.0)

    spent = {"v": 0.0}
    monkeypatch.setattr(llm, "get_spent", lambda: spent["v"])
    monkeypatch.setattr(llm, "_charge", lambda d: spent.__setitem__("v", spent["v"] + d))

    # set budget cap to 6: first attempt (5.0) fits, second (5.0) would exceed
    old = llm._cap[0]
    llm._cap[0] = 6.0
    try:
        t = FakeTransport()
        res = llm.call("role", "sys", [{"role": "user", "content": "hi"}],
                       max_tokens=50, _transport=t)
    finally:
        llm._cap[0] = old

    # Expected (fixed) behaviour: retry must be skipped when budget exhausted,
    # so only one transport call and spent must stay within cap.
    assert len(t.calls) == 1, f"retry executed without cap check: calls={t.calls}"
    assert spent["v"] <= 6.0 + 1e-9, f"budget overrun: spent={spent['v']}"


class BughuntB24(unittest.TestCase):
    def test_b24(self):
        with pytest.MonkeyPatch.context() as mp:
            test_retry_respects_cap(mp)
