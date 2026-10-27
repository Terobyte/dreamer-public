"""ASR bench: how long after you stop talking the turn's text is ready, three ways.

Same phrases (Fish TTS, 16 kHz) streamed in real time as 20 ms frames, like the mic:
- meta_batch: wait for TURN_GAP of silence, then send the whole utterance to Meta ASR;
- meta_chunks: rt.py's MetaTurns, chunks go to Meta ASR while you talk (the "pseudo-websocket");
- flux: Deepgram Flux websocket, semantic EndOfTurn (EagerEndOfTurn noted too).
Clock starts at the last loud frame of the phrase. LLM and TTS are the same for all, so they are left out.
usage: agentx/.venv/bin/python asr_bench.py [rounds]
"""
import asyncio
import json
import re
import sys
import time

import aiohttp
import numpy as np
import websockets

import rt
from gate_test import SPONGEBOB_VOICE

PHRASES = {
    "short": "Squidward, open the door!",
    "medium": "Squidward, I really need to come inside, there's a giant jellyfish swarm coming down the street!",
    "pause": "Squidward, listen... Gary crawled into your house through the mail slot. "
             "And I have to get him back before Mister Krabs finds out I left the grill!",
    "long": "Okay, okay, I know you hate it when I knock this early, but this is a real emergency, Squidward. "
            "The jellyfish are everywhere, Patrick is hiding under his rock, and you are the only one "
            "on Conch Street with a door that actually locks. Please, please, please let me in!",
}
TAIL = 6.0  # seconds of silence streamed after the phrase, enough for any end-of-turn
OUT = rt.HERE.parent / "out" / "asr_bench.json"


async def tts16(http, text):
    body = {"text": text, "reference_id": SPONGEBOB_VOICE, "format": "pcm", "sample_rate": 16000}
    async with http.post("https://api.fish.audio/v1/tts", json=body,
                         headers={"Authorization": f"Bearer {rt.FISH_KEY}", "model": "s2-pro"}) as r:
        r.raise_for_status()
        return await r.read()


def speech_end(pcm):
    """seconds from the start to the end of the last loud 20 ms frame"""
    x = np.frombuffer(pcm[:len(pcm) // rt.FRAME * rt.FRAME], np.int16).astype(np.float32) / 32768
    rms = np.sqrt((x.reshape(-1, rt.FRAME // 2) ** 2).mean(1))
    return (np.nonzero(rms > rt.LOUD)[0][-1] + 1) * 0.02


async def stream(pcm, push, done):
    """feed pcm + silence at real-time pace until done() is set; returns the wall time the phrase started"""
    audio = pcm + bytes(int(TAIL * 32000))
    t0 = time.time()
    for i in range(0, len(audio), rt.FRAME):
        if done.is_set():
            break
        await push(audio[i:i + rt.FRAME])
        await asyncio.sleep(max(0, t0 + (i + rt.FRAME) / 32000 - time.time()))
    return t0


class Probe:
    """stands in for rt.Session: just records when the turn ended"""

    def __init__(self, http):
        self.http, self.done, self.res = http, asyncio.Event(), {}

    async def send(self, **msg):
        pass

    async def speech_started(self):
        pass

    async def turn_ended(self, text, t, **extra):
        self.res = {"text": text, "t": t, **extra}
        self.done.set()


async def meta_chunks(http, pcm):
    p = Probe(http)
    turns = rt.MetaTurns(p)
    watch = asyncio.create_task(turns.watch())
    t0 = await stream(pcm, turns.feed, p.done)
    await asyncio.wait_for(p.done.wait(), 10)
    watch.cancel()
    return {"text": p.res["text"], "t": p.res["t"] - t0,
            "detail": f"{p.res['chunks']} кусков, последний {p.res['last_chunk_s']} с → ASR {p.res['asr_last']} мс"}


async def meta_batch(http, pcm):
    # same VAD, but nothing is sent until TURN_GAP of silence, then the whole utterance goes at once
    done, seg, quiet, heard = asyncio.Event(), bytearray(), 0.0, False
    box, pre = {}, rt.deque(maxlen=rt.PREROLL)  # same preroll as chunks, so the first syllable is kept

    async def push(frame):
        nonlocal quiet, heard
        x = np.frombuffer(frame, np.int16).astype(np.float32) / 32768
        loud = float(np.sqrt(np.mean(x * x))) > rt.LOUD
        if not heard:
            pre.append(frame)
            if loud:
                heard = True
                seg.extend(b"".join(pre)[:-len(frame)])
        if heard and "task" not in box:
            seg.extend(frame)
            quiet = 0 if loud else quiet + 0.02
            if quiet >= rt.TURN_GAP:
                box["task"] = asyncio.create_task(asr(bytes(seg)))

    async def asr(audio):
        t = time.time()
        box["text"] = await rt.meta_asr(http, audio)
        box["asr"], box["t"] = round((time.time() - t) * 1000), time.time()
        done.set()

    t0 = await stream(pcm, push, done)
    await asyncio.wait_for(done.wait(), 10)
    return {"text": box["text"], "t": box["t"] - t0,
            "detail": f"ждём {rt.TURN_GAP} с тишины + ASR всей фразы {len(pcm) / 32000:.1f} с → {box['asr']} мс"}


async def flux(http, pcm):
    dg = await websockets.connect(rt.FLUX, additional_headers={"Authorization": f"Token {rt.DG_KEY}"})
    done, box = asyncio.Event(), {}

    async def read():
        async for raw in dg:
            ev = json.loads(raw)
            if ev.get("type") != "TurnInfo":
                continue
            if ev["event"] == "EagerEndOfTurn":
                box.setdefault("eager", time.time())
            elif ev["event"] == "EndOfTurn" and ev.get("transcript", "").strip():
                box["text"], box["t"] = ev["transcript"], time.time()
                done.set()
                return

    reader = asyncio.create_task(read())
    t0 = await stream(pcm, dg.send, done)
    await asyncio.wait_for(done.wait(), 10)
    reader.cancel()
    await dg.close()
    eager = f"eager {box['eager'] - t0 - speech_end(pcm):+.2f} с" if "eager" in box else "eager —"
    return {"text": box["text"], "t": box["t"] - t0, "detail": eager}


MODES = {"meta_batch": meta_batch, "meta_chunks": meta_chunks, "flux": flux}
if len(sys.argv) > 2:  # run only the named modes
    MODES = {m: MODES[m] for m in sys.argv[2].split(",")}


def wer(ref, hyp):
    """word error rate, punctuation and case ignored"""
    r, h = (re.sub(r"[^\w\s']", " ", t.lower()).split() for t in (ref, hyp))
    d = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hw in enumerate(h, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (rw != hw))
    return d[-1] / len(r)


async def main(rounds):
    async with aiohttp.ClientSession() as http:
        audio = {k: await tts16(http, v) for k, v in PHRASES.items()}
        rows = []
        for r in range(rounds):
            for name, pcm in audio.items():
                end = speech_end(pcm)
                for mode, fn in MODES.items():  # interleaved, so API drift hits every mode alike
                    res = await fn(http, pcm)
                    wait = res["t"] - end
                    rows.append({"round": r, "phrase": name, "speech_s": round(end, 1), "mode": mode,
                                 "wait_ms": round(wait * 1000), "wer": wer(PHRASES[name], res["text"]),
                                 "text": res["text"], "detail": res["detail"]})
                    print(f"{r} {name:6s} {end:4.1f}s {mode:11s} {wait * 1000:5.0f} мс  "
                          f"WER {rows[-1]['wer']:.0%}  {res['detail']}\n"
                          f"     {res['text']}", flush=True)
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    print("\nмедиана, мс (конец речи → текст готов)")
    print("фраза     " + "".join(f"{m:>13s}" for m in MODES))
    for name in PHRASES:
        print(f"{name:9s} " + "".join(
            f"{np.median([x['wait_ms'] for x in rows if x['phrase'] == name and x['mode'] == m]):13.0f}" for m in MODES))
    print("все      " + "".join(f"{np.median([x['wait_ms'] for x in rows if x['mode'] == m]):13.0f}" for m in MODES))
    print("WER      " + "".join(f"{np.mean([x['wer'] for x in rows if x['mode'] == m]):13.1%}" for m in MODES))


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 3))
