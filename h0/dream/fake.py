"""Fake offline transports for tests (no network, no keys).
usage: cd h0/dream && python3 -m unittest -q
FakeTransport(script) replays lines in order; FakeTransport(reply=fn) answers by role
(fn sees the system prompt, so a background compress never eats the script);
FakeTransport(gate=threading.Event()) holds every call until the gate is set --
"a call in flight" without a real sleep (spec 7.2, fixtures of phase 1); `entered`
is set the moment a call reaches the gate, so a test synchronises on it instead of
sleeping."""

import threading


class FakeTransport:
    """Replays scripted LLM replies; records what was sent."""

    def __init__(self, script=(), reply=None, gate=None):
        self.script = list(script)
        self.reply = reply
        self.gate = gate
        self.entered = threading.Event()
        self.calls = 0
        self.sent = []

    def complete(self, model, effort, system, messages, max_tokens):
        self.sent.append({"model": model, "effort": effort,
                          "system": system, "messages": messages,
                          "max_tokens": max_tokens})
        self.calls += 1
        if self.gate is not None:
            self.entered.set()
            self.gate.wait(5)
        if self.reply is not None:
            return self.reply(model, effort, system, messages)
        idx = min(self.calls - 1, len(self.script) - 1)
        if self.script:
            return self.script[idx]
        return ""
