import asyncio
import os
import sys
import types
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("META_MODEL_API_KEY", "test-meta-key")

gate_stub = types.ModuleType("gate_test")
gate_stub.OPEN = ""
gate_stub.SQUIDWARD_VOICE = "test-voice"
gate_stub.fish_key = lambda: "test-fish-key"
load_stub = types.ModuleType("load_test")
load_stub.SQUIDWARD_LOAD = "test system prompt"
sys.modules["gate_test"] = gate_stub
sys.modules["load_test"] = load_stub

# rt.py reads the local Deepgram key file at import time. Supply a dummy value;
# these tests never make an external request.
with patch.object(Path, "read_text", return_value="DEEPGRAM_API_KEY=test-key\n"):
    import rt

from aiohttp import web


def test_B31_websocket_rejects_untrusted_origin():
    async def run():
        class FakeWS:
            closed = False
            status = 101

            async def prepare(self, _request):
                return self

            def __aiter__(self):
                async def empty():
                    if False:
                        yield None
                return empty()

        fake_ws = FakeWS()
        request = types.SimpleNamespace(
            headers={"Origin": "http://evil.com"}, query={},
        )
        with patch.object(rt.web, "WebSocketResponse", return_value=fake_ws):
            try:
                await rt.ws_handler(request)
            except web.HTTPForbidden:
                return
        assert fake_ws.status == 403

    asyncio.run(run())


def test_B34_failed_asr_chunk_does_not_stop_later_turn_detection():
    class StubSession:
        def __init__(self):
            self.ended = []
            self.history = []
            self.progress = 0
            self.audio_started = False
            self.ws = types.SimpleNamespace(send_json=self._send, send_bytes=self._send)
            self.http = object()

        async def _send(self, *_args, **_kwargs):
            pass

        async def send(self, **message):
            await self._send(message)

        async def turn_ended(self, text, *_args, **_kwargs):
            self.ended.append(text)

    async def run():
        session = StubSession()
        turns = rt.MetaTurns(session)
        failed = asyncio.get_running_loop().create_future()
        failed.set_exception(RuntimeError("ASR chunk failed"))
        good = asyncio.get_running_loop().create_future()
        good.set_result(("hello.", 12, 0.2))
        turns.chunks = [failed, good]
        turns.in_speech = False
        turns.last_speech = 0
        watcher = asyncio.create_task(turns.watch())
        try:
            for _ in range(20):
                await asyncio.sleep(0)
                if session.ended:
                    break
                if watcher.done():
                    break
            assert session.ended == ["hello."]

            async def failed_spark(_http, _messages):
                if False:
                    yield ""

            with patch.object(rt, "spark", failed_spark):
                await rt.Session.respond(session, "hello", 0, None, {})
            assert not any(m["role"] == "assistant" and not m["content"]
                           for m in session.history)
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    asyncio.run(run())
