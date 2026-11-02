"""H9 live loop: you are SpongeBob at Squidward's door, by voice.

Browser records push-to-talk audio -> /asr (Meta muse-voice-transcribe) -> /turn (Spark 1.3 minimal as
Squidward, with the room_loading % from the page) -> /tts streams Fish Drama 3 mp3 back while it is made.
Keys stay here; the page only talks to localhost.
usage: python server.py  ->  http://localhost:8090
"""
import json
import os
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from gate_test import OPEN, SQUIDWARD_VOICE, chat, fish_key  # noqa: E402
from load_test import SQUIDWARD_LOAD  # noqa: E402

META_KEY = os.environ["META_MODEL_API_KEY"]
FISH_KEY = fish_key()
PORT = 8090

history = []  # Squidward's chat history, one live session
lines = {}  # tts id -> spoken text
lock = threading.Lock()  # B32: handler threads share history and lines


def transcribe(wav):
    b = uuid.uuid4().hex
    req = json.dumps({"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "sampleRateHertz": 16000})
    body = (f'--{b}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n{req}\r\n'
            f'--{b}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'
            ).encode() + wav + f"\r\n--{b}--\r\n".encode()
    r = urllib.request.Request("https://api.meta.ai/v1/asr/transcribe", body,
                               {"Authorization": f"Bearer {META_KEY}", "Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read()).get("transcript", "").strip()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def trusted(self):
        """B32: only our own page on localhost. A foreign Origin is CSRF; a foreign
        Host is DNS rebinding. Either would spend ASR/Spark/Fish on our keys."""
        port = self.server.server_address[1]
        own = {f"localhost:{port}", f"127.0.0.1:{port}"}
        origin = self.headers.get("Origin")
        if self.headers.get("Host") not in own or (origin is not None and
                                                    origin not in {f"http://{h}" for h in own}):
            self.close_connection = True  # the unread body must not become the next request
            self.send_error(403)
            return False
        return True

    def do_GET(self):
        if self.path == "/":
            data = (HERE / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(data)
        elif self.path.startswith("/tts/"):
            if not self.trusted():
                return
            with lock:
                text = lines.get(self.path[5:])  # get: the audio tag may fetch twice
            if not text:
                self.send_error(404)  # B32: no Fish call for an unknown id
                return
            self.stream_tts(text)
        else:
            self.send_error(404)

    def do_POST(self):
        t0 = time.time()
        if not self.trusted():
            return
        if self.path == "/asr":
            try:
                wav = self.body()
            except ValueError:  # Content-Length is not a number
                self.close_connection = True  # the unread body must not become the next request
                self.send_json({"error": "bad Content-Length"}, 400)
                return
            try:
                text = transcribe(wav)
            except (OSError, ValueError) as e:  # URLError/HTTPError are OSErrors: the upstream failed
                self.send_json({"error": f"asr failed: {type(e).__name__}"}, 502)
                return
            self.send_json({"text": text, "ms": round((time.time() - t0) * 1000)})
        elif self.path == "/turn":
            try:
                req = json.loads(self.body())
                user = f"[STATE room_loading={int(req['progress'])}%]\n{str(req['text'])}"
            except (ValueError, KeyError, TypeError):
                self.send_error(400)  # B32: a bad body gets an answer, not a dead socket
                return
            with lock:  # one turn at a time: history is one live session
                history.append({"role": "user", "content": user})
                line, ttft, _ = chat(SQUIDWARD_LOAD, history)
                history.append({"role": "assistant", "content": line})
                spoken = line.replace(OPEN, "").strip()
                tid = uuid.uuid4().hex[:8]
                lines[tid] = spoken
            self.send_json({"line": spoken, "opened": OPEN in line, "tts": f"/tts/{tid}",
                            "ttft": round((ttft or 0) * 1000), "ms": round((time.time() - t0) * 1000)})
        elif self.path == "/reset":
            with lock:
                history.clear()
            self.send_json({"ok": True})
        else:
            self.send_error(404)

    def stream_tts(self, text):
        # pass Fish's mp3 through chunk by chunk so the browser starts playing before synthesis ends
        r = urllib.request.Request("https://api.fish.audio/v1/tts",
                                   json.dumps({"text": text, "reference_id": SQUIDWARD_VOICE, "format": "mp3",
                                               "latency": "balanced"}).encode(),
                                   {"Authorization": f"Bearer {FISH_KEY}", "Content-Type": "application/json",
                                    "model": "drama-3"})
        with urllib.request.urlopen(r, timeout=60) as resp:
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.end_headers()
            while chunk := resp.read(4096):
                self.wfile.write(chunk)
                self.wfile.flush()

    def log_message(self, fmt, *args):
        print(time.strftime("%H:%M:%S"), fmt % args, flush=True)


if __name__ == "__main__":
    print(f"http://localhost:{PORT}")
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
