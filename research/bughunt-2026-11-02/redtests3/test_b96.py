"""B96: Spark's non-SSE HTTP error body must surface as a turn error."""
import os
import sys
import types
from pathlib import Path
from unittest.mock import patch

os.environ["META_MODEL_API_KEY"] = "redtest-dummy"
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "h0" / "live"))
gt = types.ModuleType("gate_test")
gt.OPEN, gt.SQUIDWARD_VOICE, gt.fish_key = "<open>", "voice", lambda: "dummy"
sys.modules["gate_test"] = gt
lt = types.ModuleType("load_test")
lt.SQUIDWARD_LOAD = "load"
sys.modules["load_test"] = lt
# rt.py reads the Deepgram key from a sibling .env at import time; replace that read with a dummy value.
with patch.object(Path, "read_text", return_value="DEEPGRAM_API_KEY=redtest-dummy\n"):
    # The exercised Session/spark paths do not use these transport dependencies;
    # keep this offline test lean and deterministic without loading audio/network stacks.
    numpy = types.ModuleType("numpy")
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = types.ModuleType("aiohttp.web")
    aiohttp.web.Application = lambda: types.SimpleNamespace(
        router=types.SimpleNamespace(add_get=lambda *args, **kwargs: None))
    websockets = types.ModuleType("websockets")
    with patch.dict(sys.modules, {"numpy": numpy, "aiohttp": aiohttp,
                                  "aiohttp.web": aiohttp.web, "websockets": websockets}):
        import rt  # noqa: E402


class _Response:
    def __init__(self, body):
        self.content = self
        self.body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def __aiter__(self):
        async def stream():
            for line in self.body:
                yield line
        return stream()


class _HTTP:
    def __init__(self, body):
        self.response = _Response(body)

    def post(self, *args, **kwargs):
        return self.response


class _WS:
    closed = False

    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(message)

    async def send_bytes(self, data):
        pass


def test_spark_http_error_reaches_done_metrics(monkeypatch):
    async def go():
        # Control: a normal SSE response is consumed and the reply reaches history.
        ws_ok = _WS()
        session_ok = rt.Session(ws_ok, _HTTP([b'data: {"choices":[{"delta":{"content":"Hello."}}]}\n', b'data: [DONE]\n']))

        async def no_audio(http, text):
            if False:
                yield b""
        monkeypatch.setattr(rt, "fish", no_audio)
        await session_ok.respond("hi", 0, None, {})
        assert ws_ok.messages[-1]["type"] == "done"
        assert session_ok.history[-1]["content"] == "Hello."

        # HTTP 401 body is not SSE; spark() currently yields nothing and falsely completes.
        ws_err = _WS()
        session_err = rt.Session(ws_err, _HTTP([b'{"error":"Unauthorized"}\n']))
        await session_err.respond("hi", 0, None, {})
        done = ws_err.messages[-1]
        assert done["metrics"].get("error"), (
            "expected: HTTP failure surfaced in done.metrics.error; "
            f"actual: done without error ({done!r})"
        )

    import asyncio
    asyncio.run(go())
