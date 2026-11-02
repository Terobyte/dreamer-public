import json
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock
import urllib.error

os.environ.setdefault("META_MODEL_API_KEY", "dummy-test-key")


FAKE_BIBLE = {
    "world": {"summary": "test world"},
    "canon": ["c1"],
    "npcs": [{"id": "squidward", "personality": ["grumpy"], "wants": "quiet",
               "never_does": ["open early"], "voice": "nasal",
               "reacts_to": {}}],
}

import gate_test as gt


def _success_response(text="hello world"):
    payload = {"choices": [{"delta": {"content": text}}]}
    raw = ("data: " + json.dumps(payload) + "\n").encode()
    m = MagicMock()
    m.__enter__.return_value = [raw]
    m.__exit__.return_value = False
    return m


def test_chat_retries_on_transient_http_error():
    calls = {"n": 0}

    def flaky_urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise urllib.error.HTTPError(req.full_url, 503, "Service Unavailable", {}, None)
        return _success_response()

    with patch.object(gt.urllib.request, "urlopen", side_effect=flaky_urlopen):
        try:
            result = gt.chat("sys", [{"role": "user", "content": "hi"}])
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            assert False, f"chat() did not retry transient error, raised on attempt {calls['n']}: {e}"
        assert isinstance(result, tuple) and result[0] == "hello world", \
            f"expected retry to succeed with text, got {result!r}"
        assert calls["n"] == 3, f"expected 3 attempts (2 failures + success), got {calls['n']}"
