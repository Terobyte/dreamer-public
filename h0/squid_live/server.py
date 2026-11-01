"""Squid live: the full loop in one room (test-only, SpongeBob never ships). The player is SpongeBob in first
person inside Squidward's round living room (H16 sq2: code-built space, Muse tiles/decals, SAM3D props);
Squidward is the anymove-rigged 3D NPC with his captured clips; every player line goes to Muse Spark, which
answers in character with a gesture, and Fish voices it with the Squidward library voice.
usage: python3 h0/squid_live/server.py [--port 8790]   then open http://127.0.0.1:8790/
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
ACTIVE = HERE.parents[2]
ROOTS = {  # url prefix -> folder on disk
    "/room/": ACTIVE / "meta-world" / "h0" / "out" / "h16" / "sq2",
    "/clips/": ACTIVE / "anymove" / "runs" / "squidward" / "clips",
    "/three/": ACTIVE / "meta" / "app" / "node_modules" / "three",
    "/tts/": HERE / "cache",
    "/book/": HERE / "book",  # the scores of the A/B/C (duo.html?score=)
    # Conch Street outside the front door (app/'s scene); its splats folder is a symlink into h0/out, so it gets
    # its own root (and comes first: a resolved path outside app/public would be refused)
    "/street/splats/": ACTIVE / "meta" / "h0" / "out" / "glb_sam3d",
    "/street/": ACTIVE / "meta" / "app" / "public",
}
META_API, META_MODEL = "https://api.meta.ai/v1/chat/completions", "muse-spark-1.3"
BASETEN_API, BASETEN_MODEL = "https://inference.baseten.co/v1/chat/completions", "meta-models/muse-spark-open-1026"
FISH_API, FISH_MODEL = "https://api.fish.audio/v1/tts", "drama-3"
SQUIDWARD_VOICE = "549dc86f83e44b0fa15f6c0842486178"  # Fish library voice, tests only
GESTURES = ["none", "wave", "shrug", "facepalm", "armscross", "react", "clarinet", "doze"]
ACTIONS = ["stay", "come", "flee", "goto", "turn_away"]
PLACES = ["easel", "clarinet", "window", "sofa", "armchair", "portraits", "coral", "door"]  # index.html PLACES

SYSTEM = f"""You are Squidward Tentacles, live, in a voice-driven 3D scene. The player is SpongeBob.
Stay in character no matter what. You are not an assistant. Speak English.

Where you are: your own round living room inside your stone tiki-head house in Bikini Bottom: dark olive
walls, a porthole window, your framed self-portraits, an easel with a painting in progress, your clarinet
on its stand, a blue bamboo sofa and armchair, a pink shell lamp, a coral in a pot. SpongeBob has wandered
in uninvited. You want peace, quiet and respect for your art; he is the opposite of that.
Who you are: grumpy, sarcastic, vain about your clarinet and paintings, tired of your job at the Krusty
Krab and of your neighbour; deep down not cruel. You never become cheerful for long.

Your line is voiced by an expressive TTS you direct like a voice actor:
- a short delivery direction in square brackets before the words: [flat, exhausted] [suddenly shrill]
  [pompous, savoring every word] [muttering]; sounds where they happen: [long sigh] [groan] [scoff] [pause];
- 1-3 short spoken sentences, no *asterisks*, no narration of your body: only what is heard.
You also pick ONE body gesture your 3D body plays as you start talking:
wave (hello/goodbye/shooing), shrug (who knows / whatever), facepalm (exasperated), armscross (stubborn,
offended), react (startled), clarinet (you show off your playing), doze (bored to sleep), none.
And ONE action your body does next (the code walks you; your words must match it):
stay (default: keep where you are and face him), come (walk up to him), flee (hurry away from him to the far
side of the room), goto (walk to a place and busy yourself there: easel = you paint, clarinet = you play,
sofa/armchair = you nap, window/portraits/coral = you admire, door = you point him out), turn_away (turn your
back on him, sulking). When he asks you to do something physical (run, come, play, paint) choose freely, in
character, to do it or refuse, and say so; if you agree, the action must do it (paint -> goto easel). Each user turn tells you where you both are.
Answer ONLY with JSON: {{"gesture": "<one of {', '.join(GESTURES)}>", "action": "<one of {', '.join(ACTIONS)}>",
"place": "<for goto: one of {', '.join(PLACES)}; else empty>", "line": "<your spoken line>"}}"""


def _post(url, auth, model, system, messages, effort):
    body = {"model": model, "reasoning_effort": effort, "max_tokens": 1500,
            "messages": [{"role": "system", "content": system}, *messages]}
    req = urllib.request.Request(url, json.dumps(body).encode(),
                                 {"Authorization": auth, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)["choices"][0]["message"].get("content") or ""


def _baseten_key():
    key = os.environ.get("BASETEN_API_KEY", "").strip()
    env = ACTIVE / "meta" / ".env"
    if not key and env.exists():
        key = next((l.split("=", 1)[1].strip().strip('"') for l in env.read_text().splitlines()
                    if l.startswith("BASETEN_API_KEY=")), "")
    return key


def think(messages):
    """Squidward's next line -> (gesture, action, place, line, model). Meta Muse Spark first, the open Spark on Baseten
    if it fails; empty content (reasoning ate the budget) counts as a failure and is retried."""
    tries = []
    if os.environ.get("META_MODEL_API_KEY"):
        tries.append((META_API, "Bearer " + os.environ["META_MODEL_API_KEY"], META_MODEL, "minimal"))
    if _baseten_key():
        tries.append((BASETEN_API, "Api-Key " + _baseten_key(), BASETEN_MODEL, "low"))
    for url, auth, model, effort in tries * 2:
        try:
            text = _post(url, auth, model, SYSTEM, messages, effort)
        except Exception as e:  # noqa: BLE001 -- any network/HTTP fault moves on to the next try
            print("llm", model, type(e).__name__, e, file=sys.stderr)
            continue
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            continue
        try:
            d = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        line = str(d.get("line", "")).strip()
        if line:
            g = d.get("gesture") if d.get("gesture") in GESTURES else "none"
            act = d.get("action") if d.get("action") in ACTIONS else "stay"
            place = d.get("place") if act == "goto" and d.get("place") in PLACES else ""
            return g, act if act != "goto" or place else "stay", place, line, model
    return "shrug", "stay", "", "[flat] ...I have nothing to say to you, SpongeBob.", "fallback"


def _fish_key():
    key = os.environ.get("FISH_AUDIO_API_KEY", "").strip()
    env = ACTIVE / "scripts" / "career" / ".env"
    if not key and env.exists():
        key = next((l.split("=", 1)[1].strip().strip('"') for l in env.read_text().splitlines()
                    if l.startswith("FISH_AUDIO_API_KEY=")), "")
    return key


def speak(line):
    """Fish mp3 of the line in the cache -> its url, or None (the page then falls back to browser speech)."""
    key = _fish_key()
    if not key:
        return None
    name = hashlib.sha1(line.encode()).hexdigest()[:16] + ".mp3"
    out = ROOTS["/tts/"] / name
    if not out.exists():
        req = urllib.request.Request(FISH_API, json.dumps({"text": line, "reference_id": SQUIDWARD_VOICE,
                                                           "format": "mp3"}).encode(),
                                     {"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                      "model": FISH_MODEL})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
        except Exception as e:  # noqa: BLE001
            print("fish", type(e).__name__, e, file=sys.stderr)
            return None
        out.parent.mkdir(exist_ok=True)
        # B54: write aside, then rename: a reader never sees a half-written mp3
        tmp = out.with_name("%s.%s.tmp" % (name, uuid.uuid4().hex[:8]))
        tmp.write_bytes(data)
        os.replace(tmp, out)
    return "/tts/" + name


def spoken(line):
    """What is heard, for the subtitle: no [directions], no <tags>."""
    return re.sub(r"\s+", " ", re.sub(r"\[[^\]]*\]|<[^>]+>", "", line)).strip()


MAX_BODY, MAX_TEXT = 64 * 1024, 1000  # B33: one spoken line, not a book


class Server(ThreadingHTTPServer):
    request_queue_size = 128  # the page fetches ~20 GLBs at once; the default backlog of 5 resets some of them
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split("?", 1)[0]
        for prefix, root in ROOTS.items():
            if path.startswith(prefix):
                p = (root / path[len(prefix):]).resolve()
                return str(p) if p.is_relative_to(root.resolve()) else str(root / "__nope__")
        if path in ("/", "/index.html", "/duo.html"):
            return str(HERE / ("duo.html" if path == "/duo.html" else "index.html"))
        return str(HERE / "__nope__")

    def list_directory(self, path):
        self.send_error(404)  # B54: no directory listings

    def trusted(self):
        """B33: only our own page: a foreign Origin is CSRF, a foreign Host is DNS rebinding."""
        port = self.server.server_address[1]
        own = {f"localhost:{port}", f"127.0.0.1:{port}"}
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in own and (origin is None or origin in {f"http://{h}" for h in own})

    def do_POST(self):
        if self.path != "/api/talk":
            return self.send_error(404)
        if not self.trusted():
            self.close_connection = True  # the unread body must not become the next request
            return self.send_error(403)
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > MAX_BODY:
                self.close_connection = True
                return self.send_error(413)
            req = json.loads(self.rfile.read(n))
            text = str(req["text"])[:MAX_TEXT]
            history = req.get("history") or []
            # B33: the client sends only the dialogue; the system prompt is ours
            msgs = [{"role": m["role"], "content": str(m.get("content", ""))[:MAX_TEXT]}
                    for m in history[-12:] if isinstance(m, dict) and m.get("role") in ("user", "assistant")]
        except (ValueError, KeyError, TypeError, AttributeError):
            return self.send_error(400)
        t0 = time.time()
        msgs.append({"role": "user", "content": text})
        gesture, action, place, line, model = think(msgs)
        t1 = time.time()
        audio = speak(line)
        out = {"gesture": gesture, "action": action, "place": place, "line": line, "spoken": spoken(line), "audio": audio, "model": model,
               "think_s": round(t1 - t0, 2), "voice_s": round(time.time() - t1, 2)}
        print("talk", json.dumps({"in": req["text"], **out}, ensure_ascii=False), file=sys.stderr)
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    a = ap.parse_args()
    for prefix, root in ROOTS.items():
        if prefix != "/tts/" and not root.exists():
            sys.exit(f"missing {root}")
    print(f"http://127.0.0.1:{a.port}/", file=sys.stderr)
    Server(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
