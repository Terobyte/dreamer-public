import io
import json
import urllib.request
import pytest

import llm_http


class _FakeResp:
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode()
    def read(self):
        return self._raw
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def _run_once_with_payload(payload):
    orig = urllib.request.urlopen
    urllib.request.urlopen = lambda req, timeout=None: _FakeResp(payload)
    try:
        return llm_http._once("https://x", "auth", {}, 5)
    finally:
        urllib.request.urlopen = orig


@pytest.mark.parametrize("bad", [{"choices": ["hello"]}, {"choices": [{"message": "hello"}]}])
def test_malformed_choice_raises_transport_error_not_attribute_error(bad):
    try:
        _run_once_with_payload(bad)
    except llm_http.TransportError as exc:
        assert exc.retryable is False
    except AttributeError as exc:
        assert False, "bug B28: AttributeError leaked instead of TransportError: %r" % (exc,)
    else:
        assert False, "expected TransportError for payload %r" % (bad,)
