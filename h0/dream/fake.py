"""Fake offline transports for tests (no network, no keys).
usage: cd h0/dream && python3 -m unittest -q
"""


class FakeTransport:
    """Replays scripted LLM replies; records what was sent."""

    def __init__(self, script=()):
        self.script = list(script)
        self.calls = 0
        self.sent = []

    def complete(self, model, effort, system, messages, max_tokens):
        self.sent.append({"model": model, "effort": effort,
                          "system": system, "messages": messages,
                          "max_tokens": max_tokens})
        self.calls += 1
        idx = min(self.calls - 1, len(self.script) - 1)
        if self.script:
            return self.script[idx]
        return ""
