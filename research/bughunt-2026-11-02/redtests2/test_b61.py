"""B61: gate_test.chat dies on an empty `data:` SSE frame instead of skipping it."""
import os
import sys
import urllib.request
from pathlib import Path

os.environ.setdefault("META_MODEL_API_KEY", "dummy")
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "h0"))
import gate_test  # noqa: E402


class _Resp:
    def __init__(self, lines):
        self.lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self.lines)


def test_empty_data_frame_is_skipped(monkeypatch):
    lines = [b'data:\n',
             b'data: {"choices":[{"delta":{"content":"hello"}}]}\n',
             b'data: [DONE]\n']
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _Resp(lines))
    monkeypatch.setattr(gate_test.time, "sleep", lambda s: None)
    try:
        text, _, _ = gate_test.chat("sys", [{"role": "user", "content": "x"}])
    except Exception as e:
        raise AssertionError(f"expected: empty `data:` frame skipped, text 'hello'; "
                             f"actual: chat() raised {type(e).__name__}: {e}")
    assert text == "hello", f"expected 'hello', got {text!r}"
