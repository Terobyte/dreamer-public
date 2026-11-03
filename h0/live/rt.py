"""H9/H10 fast loop, Synapse recipe: everything streams, nothing waits for a whole reply.

mic PCM over WebSocket -> speech recognition -> Spark 1.3 minimal token stream, cut into sentences ->
each sentence to Fish Drama 3 as PCM stream -> straight back to the page.
Two recognizers, picked per connection (/ws?asr=meta|flux):
- meta: Meta Voice Transcribe is batch-only, so a server VAD cuts speech at ~300 ms micro-pauses and sends
  each chunk while you keep talking; at the end only the last short chunk is left (~0.6 s + 0.15 s/s audio).
  End of turn = 700 ms of silence, or 1200 ms when the text does not end like a sentence.
- flux: Deepgram Flux, semantic end-of-turn (the H10 fallback in RESEARCH).
Merge: if you speak again before Squidward's audio starts, his reply is cancelled and both parts become one line.
usage: agentx/.venv/bin/python rt.py  ->  http://localhost:8091
"""
import asyncio
import io
import json
import os
import re
import sys
import time
import wave
from collections import deque
from pathlib import Path

import aiohttp
import numpy as np
import websockets
from aiohttp import web

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from gate_test import OPEN, SQUIDWARD_VOICE, fish_key  # noqa: E402
from load_test import SQUIDWARD_LOAD  # noqa: E402

META_KEY = os.environ["META_MODEL_API_KEY"]
FISH_KEY = fish_key()
DG_KEY = next(l.split("=", 1)[1].strip().strip('"') for l in
              (HERE.parents[2] / "agentx" / ".env").read_text().splitlines() if l.startswith("DEEPGRAM_API_KEY="))
FLUX = "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.75"
OUT_RATE = 24000
# a sentence ends at . ! ? (or …) followed by a space, outside [directions]
SENTENCE = re.compile(r"^(.*?[.!?…]+[\"')]*)\s+(?![^\[]*\])", re.S)

# server VAD for the meta recognizer: 20 ms frames of 16 kHz s16le
FRAME = 640
LOUD = 0.012  # RMS, after the browser's noise suppression
CHUNK_GAP, TURN_GAP, TURN_GAP_UNFINISHED = 0.3, 0.6, 1.2
# speech without real pauses still gets cut, so the last chunk (the one you wait for) stays short:
# past SOFT_CUT seconds cut in the middle of the first dip between words that lasts DIP_FRAMES,
# past HARD_CUT cut at the quietest frame of the last half second; never at a single quiet frame mid-word
SOFT_CUT, HARD_CUT, DIP, DIP_FRAMES = 2.0, 4.0, 0.35, 8
PREROLL = 10  # frames kept before speech starts, so the first syllable is not clipped


async def spark(http, messages):
    body = {"model": "muse-spark-1.3-contributor", "reasoning_effort": "minimal", "max_tokens": 300, "stream": True,
            "messages": [{"role": "system", "content": SQUIDWARD_LOAD}, *messages]}
    async with http.post("https://api.meta.ai/v1/chat/completions", json=body,
                         headers={"Authorization": f"Bearer {META_KEY}"}) as r:
        r.raise_for_status()  # B96: a 401/429/500 body is not SSE, it must not look like an empty reply
        async for raw in r.content:
            line = raw.decode().strip()
            if line.startswith("data:") and line != "data: [DONE]":
                for ch in json.loads(line[5:]).get("choices", []):
                    if piece := (ch.get("delta") or {}).get("content"):
                        yield piece


async def fish(http, text):
    body = {"text": text, "reference_id": SQUIDWARD_VOICE, "format": "pcm", "sample_rate": OUT_RATE,
            "latency": "balanced"}
    async with http.post("https://api.fish.audio/v1/tts", json=body,
                         headers={"Authorization": f"Bearer {FISH_KEY}", "model": "drama-3"}) as r:
        r.raise_for_status()
        async for chunk in r.content.iter_chunked(4800):
            yield chunk


async def meta_asr(http, pcm):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(16000), w.writeframes(pcm)
    form = aiohttp.FormData()
    form.add_field("request", json.dumps({"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV",
                                          "sampleRateHertz": 16000}), content_type="application/json")
    form.add_field("audio", buf.getvalue(), filename="a.wav", content_type="audio/wav")
    async with http.post("https://api.meta.ai/v1/asr/transcribe", data=form,
                         headers={"Authorization": f"Bearer {META_KEY}"}) as r:
        return (await r.json()).get("transcript", "").strip()


class Session:
    def __init__(self, ws, http):
        self.ws, self.http = ws, http
        self.history, self.progress = [], 0
        self.reply, self.audio_started = None, False
        self.pending, self.prefix = "", ""  # text of the in-flight turn / of a cancelled one to merge

    async def send(self, **msg):
        if not self.ws.closed:
            await self.ws.send_json(msg)

    def busy(self):
        return self.reply is not None and not self.reply.done()

    async def speech_started(self):
        # you kept talking before he made a sound: drop his reply, your next words extend the same line
        if self.busy() and not self.audio_started:
            self.reply.cancel()
            self.prefix = self.pending
            await self.send(type="cancel")

    async def turn_ended(self, text, t_eot, **extra):
        merged = bool(self.prefix)
        text = f"{self.prefix} {text}".strip()
        self.prefix = ""
        self.pending = text
        await self.send(type="user", text=text, merge=merged)
        prev = self.reply if self.busy() else None  # he is already speaking: answer right after him
        self.reply = asyncio.create_task(self.respond(text, t_eot, prev, extra))

    async def respond(self, text, t_eot, prev, extra):
        if prev:
            await asyncio.gather(prev, return_exceptions=True)
        self.audio_started = False
        pct = self.progress
        user = {"role": "user", "content": f"[STATE room_loading={pct}%]\n{text}"}
        full, buf, m = "", "", {"progress": pct, **extra}
        sentences = asyncio.Queue()

        async def speak():  # TTS runs one sentence behind the LLM, audio goes out as it arrives
            while (s := await sentences.get()) is not None:
                async for chunk in fish(self.http, s):
                    if not self.audio_started:
                        self.audio_started = True
                        m["first_audio"] = round((time.time() - t_eot) * 1000)
                    await self.ws.send_bytes(chunk)

        speaker = asyncio.create_task(speak())
        try:
            async for piece in spark(self.http, [*self.history, user]):
                m.setdefault("ttft", round((time.time() - t_eot) * 1000))
                full += piece
                buf += piece
                while mt := SENTENCE.match(buf):
                    s = mt.group(1).replace(OPEN, "").strip()
                    buf = buf[mt.end():]
                    if s:
                        m.setdefault("first_sentence", round((time.time() - t_eot) * 1000))
                        await sentences.put(s)
                        await self.send(type="sq", text=s)
            if tail := buf.replace(OPEN, "").strip():
                await sentences.put(tail)
                await self.send(type="sq", text=tail)
            await sentences.put(None)
            await speaker
        except asyncio.CancelledError:
            raise
        except Exception as e:  # B34: a failed Spark/Fish call still ends the turn
            m["error"] = f"{type(e).__name__}: {e}"
        finally:
            speaker.cancel()
        # history only gets finished turns, so a cancelled or empty reply leaves no trace
        if full.strip() and "error" not in m:
            self.history += [user, {"role": "assistant", "content": full}]
        await self.send(type="done", opened=OPEN in full, metrics=m)


def join(parts):
    """glue chunk transcripts: drop a seam word heard twice ("Squidward," + "ward, I"), drop the chunk's own full stop"""
    words = []
    for part in filter(None, parts):
        new = part.split()
        if words:
            words[-1] = re.sub(r"[.,:;!]+$", "", words[-1])
            a, b = (re.sub(r"\W", "", w).lower() for w in (words[-1], new[0]))
            if b and (a == b or (len(b) >= 3 and a.endswith(b))):  # not "hi" + "I"
                new = new[1:]
        words += new
    return " ".join(words)


class MetaTurns:
    """VAD-cut chunks to Meta ASR while you talk; decides end of turn from silence and punctuation."""

    def __init__(self, s):
        self.s, self.raw = s, bytearray()
        self.preroll, self.seg, self.in_speech, self.quiet = deque(maxlen=PREROLL), bytearray(), False, 0
        self.chunks, self.last_speech = [], 0.0  # asr tasks of the current turn, in order
        self.level = LOUD  # running loudness of your voice, a dip is DIP of it
        self.rms, self.dip = [], 0  # per-frame loudness of the current chunk, length of the current dip

    async def feed(self, data):
        self.raw += data
        while len(self.raw) >= FRAME:
            frame = bytes(self.raw[:FRAME])
            del self.raw[:FRAME]  # B34: in place, not a fresh copy of the rest per frame
            x = np.frombuffer(frame, np.int16).astype(np.float32) / 32768
            rms = float(np.sqrt(np.mean(x * x)))
            loud = rms > LOUD
            if loud:
                self.last_speech = time.time()
                self.level = 0.95 * self.level + 0.05 * rms
                if not self.in_speech:
                    self.in_speech, self.seg = True, bytearray(b"".join(self.preroll))
                    self.rms = [0.0] * len(self.preroll)
                    self.preroll.clear()  # or the next chunk would start with stale audio of this one
                    await self.s.speech_started()
                self.quiet = 0
            if self.in_speech:
                self.seg += frame
                self.rms.append(rms)
                self.quiet = 0 if loud else self.quiet + 0.02
                self.dip = self.dip + 1 if rms < DIP * self.level else 0
                dur = len(self.seg) / 32000
                if dur > SOFT_CUT and self.dip >= DIP_FRAMES:
                    self.cut(len(self.rms) - self.dip // 2)
                elif dur > HARD_CUT:
                    self.cut(len(self.rms) - 25 + int(np.argmin(self.rms[-25:])))
                elif self.quiet >= CHUNK_GAP:
                    self.in_speech = False
                    if len(self.seg) > FRAME * (CHUNK_GAP / 0.02 + 8):  # >160 ms of actual sound
                        self.chunks.append(asyncio.create_task(self.transcribe(bytes(self.seg))))
            else:
                self.preroll.append(frame)

    def cut(self, i):
        """still talking: send the chunk up to frame i, the rest starts the next one"""
        self.chunks.append(asyncio.create_task(self.transcribe(bytes(self.seg[:i * FRAME]))))
        self.seg, self.rms, self.dip = self.seg[i * FRAME:], self.rms[i:], 0

    async def transcribe(self, pcm):
        t = time.time()
        text = await meta_asr(self.s.http, pcm)
        if text:  # show what is heard so far: finished chunks of this turn plus this one
            me = asyncio.current_task()  # B62: speech order, whichever request returned first
            parts = [text if c is me else _text(c) if c.done() else "" for c in self.chunks]
            await self.s.send(type="partial", text=join(parts if me in self.chunks else parts + [text]))
        return text, round((time.time() - t) * 1000), len(pcm) / 32000

    async def watch(self):
        while True:
            await asyncio.sleep(0.05)
            if self.in_speech or not self.chunks or not all(c.done() for c in self.chunks):
                continue
            # B34: a failed chunk counts as silence, it must not kill the watcher
            results = [c.result() if not c.cancelled() and c.exception() is None else ("", 0, 0.0)
                       for c in self.chunks]
            text = join(r[0] for r in results)
            gap = time.time() - self.last_speech
            if not text:
                self.chunks = []
            elif gap >= TURN_GAP_UNFINISHED or (gap >= TURN_GAP and re.search(r"[.!?…][\"')]*$", text)):
                self.chunks = []
                last_ms, last_s = results[-1][1], results[-1][2]
                await self.s.turn_ended(text, time.time(), asr_last=last_ms, last_chunk_s=round(last_s, 1),
                                        chunks=len(results))


def _text(chunk):
    return chunk.result()[0] if not chunk.cancelled() and chunk.exception() is None else ""


# B31: only this page may open the socket (any tab could run ASR + Spark + Fish on our keys)
ORIGINS = {"http://localhost:8091", "http://127.0.0.1:8091"}


async def ws_handler(request):
    if request.headers.get("Origin") not in ORIGINS:
        raise web.HTTPForbidden(text="origin not allowed")
    ws = web.WebSocketResponse(max_msg_size=1 << 20)  # B34: 0 meant no limit
    await ws.prepare(request)
    mode = request.query.get("asr", "meta")
    async with aiohttp.ClientSession() as http:
        s = Session(ws, http)
        if mode == "flux":
            dg = await websockets.connect(FLUX, additional_headers={"Authorization": f"Token {DG_KEY}"})

            async def from_flux():
                async for raw in dg:
                    ev = json.loads(raw)
                    if ev.get("type") != "TurnInfo":
                        continue
                    if ev["event"] == "StartOfTurn":
                        await s.speech_started()
                    elif ev["event"] == "Update" and ev.get("transcript"):
                        await s.send(type="partial", text=ev["transcript"])
                    elif ev["event"] == "EndOfTurn" and ev.get("transcript", "").strip():
                        await s.turn_ended(ev["transcript"], time.time())

            bg, push = asyncio.create_task(from_flux()), dg.send
        else:
            turns = MetaTurns(s)
            bg, push = asyncio.create_task(turns.watch()), turns.feed
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    await push(msg.data)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        ctl = json.loads(msg.data)
                    except ValueError:
                        continue  # a text frame that is not JSON: ignored, the socket stays open
                    if isinstance(ctl, dict):
                        s.progress = ctl.get("progress", s.progress)
        finally:
            bg.cancel()
            if s.busy():
                s.reply.cancel()
            if mode == "flux":
                await dg.close()
    return ws


app = web.Application()
app.router.add_get("/", lambda r: web.FileResponse(HERE / "rt.html"))
app.router.add_get("/ws", ws_handler)

if __name__ == "__main__":
    web.run_app(app, host="localhost", port=8091)
