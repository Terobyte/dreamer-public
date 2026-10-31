"""B32: live/server.py must refuse a cross-origin POST to /turn before any paid LLM call."""
import http.client
import json
import os
import threading
from http.server import ThreadingHTTPServer

import pytest

os.environ.setdefault("META_MODEL_API_KEY", "dummy-test-key")
import server  # noqa: E402


@pytest.fixture
def live_port():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def test_B32_cross_origin_turn_is_403_and_no_llm_call(live_port, monkeypatch):
    calls = []

    def fake_chat(*args, **kwargs):
        calls.append((args, kwargs))
        return ("[flat] hello", 0.1, None)

    monkeypatch.setattr(server, "chat", fake_chat)
    server.history.clear()
    body = json.dumps({"text": "hi", "progress": 10})
    conn = http.client.HTTPConnection("127.0.0.1", live_port, timeout=5)
    conn.request("POST", "/turn", body, {"Origin": "http://evil.com", "Content-Type": "text/plain",
                                         "Content-Length": str(len(body))})
    resp = conn.getresponse()
    resp.read()
    assert resp.status == 403
    assert calls == []
