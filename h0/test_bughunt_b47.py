"""B47: odd SSE choices/delta shapes must surface as TransportError(retryable=False)."""
import pytest
import llm_http


class _Resp:
    def __init__(self, raw):
        self._raw = raw

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.mark.parametrize("raw", [
    b'data: {"choices": ["hello"]}\n\n',
    b'data: {"choices": [{"delta": "hello"}]}',
    b'data: {"choices": [{"delta": {"content": 123}}]}\n\n',
])
def test_sse_bad_shape_is_transport_error(monkeypatch, raw):
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=None: _Resp(raw))
    try:
        llm_http._once("https://api.meta.ai/x", "auth", {}, 5)
    except llm_http.TransportError as exc:
        assert exc.retryable is False
    except (AttributeError, TypeError) as exc:
        assert False, "expected TransportError(retryable=False), got leaked %s: %s" % (type(exc).__name__, exc)
    else:
        assert False, "expected TransportError for %r" % (raw,)
