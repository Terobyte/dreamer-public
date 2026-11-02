"""B45: retry cap check prices the role's free model, not the paid model that answered."""
import llm


class T:
    def __init__(self):
        self.calls = 0

    def complete(self, model, effort, system, messages, max_tokens, **kw):
        self.calls += 1
        # Baseten failed, Meta paid model answered: empty reply, ~$5.00 billed
        return {"content": "", "model": llm.SPARK_MODEL,
                "usage": {"prompt_tokens": 1, "completion_tokens": 1176470}}


def test_paid_fallback_retry_respects_cap(monkeypatch):
    spent = {"v": 0.0}
    monkeypatch.setattr(llm, "get_spent", lambda: spent["v"])
    monkeypatch.setattr(llm, "_charge", lambda d: spent.__setitem__("v", spent["v"] + d))
    old = llm._cap[0]
    llm._cap[0] = 6.0
    try:
        t = T()
        res = llm.call("hero", "sys", [{"role": "user", "content": "hi"}], max_tokens=50, _transport=t)
    finally:
        llm._cap[0] = old
    assert t.calls == 1, "retry on paid fallback not skipped: calls=%d spent=%.2f cap=6.00" % (t.calls, spent["v"])
    assert spent["v"] <= 6.0 + 1e-9, "budget overrun: spent=%.2f" % spent["v"]
