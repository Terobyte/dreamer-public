"""B95: a Fish upstream failure in live GET /tts must produce an HTTP error."""
import os
import sys
import types
import urllib.error
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("META_MODEL_API_KEY", "redtest-dummy")
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "h0" / "live"))
gt = types.ModuleType("gate_test")
gt.OPEN, gt.SQUIDWARD_VOICE, gt.fish_key = "<open>", "voice", lambda: "dummy"
gt.chat = lambda *a, **k: ("hello", 0, None)
sys.modules["gate_test"] = gt
lt = types.ModuleType("load_test")
lt.SQUIDWARD_LOAD = "load"
sys.modules["load_test"] = lt

import server  # noqa: E402


def _do_get(path, statuses):
    handler = SimpleNamespace(
        path=path,
        trusted=lambda: True,
        send_error=lambda status: statuses.append(status),
        send_response=lambda status: statuses.append(status),
        send_header=lambda *args: None,
        end_headers=lambda: None,
        wfile=None,
    )
    handler.stream_tts = lambda text: server.Handler.stream_tts(handler, text)
    server.Handler.do_GET(handler)


def test_tts_upstream_failure_returns_502(monkeypatch):
    server.lines.clear()
    server.lines["valid-id"] = "hello"

    def fail(*a, **k):
        raise urllib.error.HTTPError("https://api.fish.audio/v1/tts", 429, "rate limited", {}, None)

    monkeypatch.setattr(server.urllib.request, "urlopen", fail)
    # Control: an unknown utterance is rejected before making any Fish request.
    control_statuses = []
    _do_get("/tts/unknown", control_statuses)
    assert control_statuses == [404]

    actual_statuses = []
    try:
        _do_get("/tts/valid-id", actual_statuses)
    except urllib.error.HTTPError:
        pass  # the unhandled upstream exception exits do_GET before any HTTP status is sent
    finally:
        server.lines.clear()
    actual = actual_statuses[0] if actual_statuses else None
    assert actual == 502, f"expected: HTTP 502 for Fish failure; actual: dead socket/no HTTP status ({actual!r})"
