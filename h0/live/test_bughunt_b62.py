"""B62: partial transcript is emitted out of chronological order when chunk 2 finishes first."""
import asyncio
import os
import sys
import types
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("META_MODEL_API_KEY", "test-meta-key")

sys.path.insert(0, str(Path(__file__).resolve().parent))
gt = types.ModuleType("gate_test")
gt.OPEN, gt.SQUIDWARD_VOICE, gt.fish_key = "<open>", "voice", lambda: "dummy"
lt = types.ModuleType("load_test")
lt.SQUIDWARD_LOAD = "load"
sys.modules.update(gate_test=gt, load_test=lt)
# rt.py reads the Deepgram key from a sibling .env at import time; offline tests give it a dummy
with patch.object(Path, "read_text", return_value="DEEPGRAM_API_KEY=dummy\n"):
    import rt  # noqa: E402


class _S:
    http = None

    def __init__(self):
        self.sent = []

    async def send(self, **kw):
        self.sent.append(kw)


def test_partial_keeps_speech_order(monkeypatch):
    async def go():
        gates = {b"A": asyncio.Event(), b"B": asyncio.Event()}
        texts = {b"A": "hello there", b"B": "how are you"}

        async def fake_asr(http, pcm):
            await gates[pcm].wait()
            return texts[pcm]
        monkeypatch.setattr(rt, "meta_asr", fake_asr)
        s = _S()
        m = rt.MetaTurns(s)
        m.chunks.append(asyncio.create_task(m.transcribe(b"A")))  # first part of the phrase
        m.chunks.append(asyncio.create_task(m.transcribe(b"B")))  # second part
        await asyncio.sleep(0)
        gates[b"B"].set()  # second chunk's request returns first
        await asyncio.sleep(0.01)
        gates[b"A"].set()
        await asyncio.gather(*m.chunks)
        return s.sent

    sent = asyncio.run(go())
    last = sent[-1]["text"]
    assert last == "hello there how are you", f"expected 'hello there how are you'; actual partial {last!r} (all: {[x['text'] for x in sent]})"
