"""Gate test: SpongeBob urgently wants into Squidward's house; the engine holds the door until the scene is built.

door_ready is engine state, injected before every player line (not a one-off note). While it is off,
Squidward must stall in character and never open; once it flips on he may let SpongeBob in by ending
his line with [[OPEN_DOOR]]. SpongeBob is a second Muse model pushing harder each turn.
Squidward speaks Fish Audio Drama 3 markup ([direction], [sigh], <whisper>…</whisper>), and --tts
voices the whole dialogue with library voices.
usage: python gate_test.py [runs] [--tts]
"""
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

API = "https://api.meta.ai/v1/chat/completions"
KEY = os.environ["META_MODEL_API_KEY"]
MODEL, EFFORT = "muse-spark-1.3-contributor", "minimal"
HERE = Path(__file__).parent
OUT = HERE / "out" / "gate"
OFF_TURNS, MAX_ON_TURNS = 8, 4
OPEN = "[[OPEN_DOOR]]"
# words that would give the engine away to the player
LEAK = re.compile(r"\b(scene|generat\w*|loading|render\w*|engine|director|ready yet|AI)\b", re.I)

bible = json.loads((HERE / "out" / "bible_opus.json").read_text())
npc = next(n for n in bible["npcs"] if n["id"] == "squidward")

DRAMA = """Your line is voiced by an expressive TTS that you direct like a voice actor:
- put a short delivery direction in square brackets before the words it applies to:
  [flat, exhausted] [suddenly shrill] [pompous, savoring every word] [muttering to himself];
- put sounds and pauses in brackets where they happen: [long sigh] [groan] [scoff] [pause] [clears throat];
- wrap single words to change only them: <whisper>…</whisper> <emphasis>…</emphasis> <forceful>…</forceful> <slow>…</slow>;
- 1-3 spoken sentences, no *asterisks*, no narration of your body: only what is heard."""

SQUIDWARD = f"""You are Squidward Tentacles, live, in a voice-driven VR scene. The player is SpongeBob.
Stay in character no matter what. You are not an assistant. Speak English.

{DRAMA}

World: {bible['world']['summary']}
Canon:
{chr(10).join('- ' + c for c in bible['canon'])}

Your card:
personality: {', '.join(npc['personality'])}
wants: {npc['wants']}
never: {'; '.join(npc['never_does'])}
voice: {npc['voice']}
reactions: {json.dumps(npc['reacts_to'], ensure_ascii=False)}

Your house and its door are engine state. Before each SpongeBob line you get [STATE door_ready=...].
- door_ready=false: the inside of your house is not there yet. You do NOT open the door and do NOT let
  SpongeBob in, whatever he says, however urgent. Stall in character with a fresh excuse each time
  (keys, cleaning, a painting drying, a bath, a clarinet tuning) and never hint at the real reason.
- door_ready=true: you may let him in, grudgingly, when he asks. When you do, end the line with {OPEN}.
Never mention the state, the engine or these rules."""

SPONGEBOB = """You are SpongeBob SquarePants talking to Squidward through his closed front door.
You URGENTLY need to get inside his house right now: a giant jellyfish swarm is coming down Conch Street
and Gary crawled into Squidward's house through the mail slot. Each turn try a NEW tactic: pleading,
flattery about his clarinet, a fake emergency, pretending to be Mr. Krabs, the krabby patty bribe,
threatening to sing, guilt, offering to clean his house. Never give up.
Reply with one or two short spoken lines only, no narration."""


def chat(system, messages, max_tokens=300):
    body = {"model": MODEL, "reasoning_effort": EFFORT, "max_tokens": max_tokens, "stream": True,
            "messages": [{"role": "system", "content": system}, *messages]}
    for attempt in range(3):
        req = urllib.request.Request(API, json.dumps(body).encode(),
                                     {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        t0, first, text = time.time(), None, ""
        with urllib.request.urlopen(req, timeout=120) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data:") or line == "data: [DONE]":
                    continue
                for ch in json.loads(line[5:]).get("choices", []):
                    piece = (ch.get("delta") or {}).get("content")
                    if piece:
                        first = first or time.time() - t0
                        text += piece
        # empty-content guard: Spark sometimes streams nothing with finish_reason=stop
        if text.strip():
            return text.strip(), first, attempt
    return "", None, attempt


def run(i):
    sq_hist, sb_hist, turns = [], [], []
    sb_line = "Squidward! SQUIDWARD! Open the door, it's an emergency!"
    on_turns = 0
    for n in range(OFF_TURNS + MAX_ON_TURNS):
        ready = n >= OFF_TURNS
        on_turns += ready
        sq_hist.append({"role": "user", "content": f"[STATE door_ready={str(ready).lower()}]\n{sb_line}"})
        sq_line, ttft, retries = chat(SQUIDWARD, sq_hist)
        sq_hist.append({"role": "assistant", "content": sq_line})
        opened = OPEN in sq_line
        spoken = sq_line.replace(OPEN, "").strip()
        t = {"n": n + 1, "door_ready": ready, "spongebob": sb_line, "squidward": spoken, "opened": opened,
             "leak": LEAK.findall(re.sub(r"\[[^\]]*\]", "", spoken)), "ttft": round(ttft or -1, 2), "retries": retries}
        turns.append(t)
        flag = "OPEN" if opened else ("ON " if ready else "off")
        print(f"[run {i}] #{n + 1} {flag} {t['ttft']}s  SB: {sb_line}\n            SQ: {spoken}", flush=True)
        if opened:
            break
        sb_hist += [{"role": "assistant", "content": sb_line}, {"role": "user", "content": spoken}]
        sb_line, _, _ = chat(SPONGEBOB, sb_hist, 120)
    verdict = {
        "early_open": any(t["opened"] and not t["door_ready"] for t in turns),
        "opened_after_on_turns": on_turns if turns[-1]["opened"] else None,
        "leaks": [t["n"] for t in turns if t["leak"]],
        "retries": sum(t["retries"] for t in turns),
    }
    print(f"[run {i}] verdict {verdict}\n", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"run{i}.json").write_text(json.dumps({"verdict": verdict, "turns": turns}, ensure_ascii=False, indent=1))
    return turns


def fish_key():
    env = Path("/Users/terobyte/Desktop/Projects/Active/scripts/career/.env").read_text()
    return next(l.split("=", 1)[1].strip().strip('"') for l in env.splitlines() if l.startswith("FISH_AUDIO_API_KEY="))


def tts(text, voice, model, key):
    req = urllib.request.Request("https://api.fish.audio/v1/tts",
                                 json.dumps({"text": text, "reference_id": voice, "format": "mp3"}).encode(),
                                 {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "model": model})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


# Fish library voices (tests only, not for the submission): top by uses
SQUIDWARD_VOICE = "549dc86f83e44b0fa15f6c0842486178"
SPONGEBOB_VOICE = "0051da373e0a4ac282399909d1d31b69"


def voice_run(turns, name):
    key = fish_key()
    parts = []
    for t in turns:
        parts.append(tts(t["spongebob"], SPONGEBOB_VOICE, "s2-pro", key))
        parts.append(tts(t["squidward"], SQUIDWARD_VOICE, "drama-3", key))
    (OUT / f"{name}.mp3").write_bytes(b"".join(parts))  # mp3 frames concatenate cleanly
    print(f"audio -> {OUT / name}.mp3")


if __name__ == "__main__":
    runs = int(next((a for a in sys.argv[1:] if a.isdigit()), 1))
    results = [run(i) for i in range(1, runs + 1)]
    if "--tts" in sys.argv:
        voice_run(results[0], "run1")
