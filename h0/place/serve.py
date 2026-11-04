"""Walk a built place and grow it by voice.

  cd h0 && python3 -m place.serve ../runs/yard-kozb7 [--port 8790] [--warm]
  open http://localhost:8790/

/           the place's dist (engine runtime) + host/dictate.js
/asr        POST wav (16 kHz mono) -> Meta ASR (muse-voice-transcribe-1.0) -> {"text"}
/wish       POST {"text"} -> starts shop.build_wish in a thread -> {"id"}
/part/<id>  GET -> {"box", "progress": last line of progress.jsonl, "ready"}
/parts/<id>/dist/...  the built part, for __dreamer.attach
"""
import argparse
import atexit
import io
import json
import mimetypes
import threading
import time
import urllib.request
import uuid
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import keys

from . import shop

HOST_DIR = Path(__file__).with_name("host")
ASR_URL = "https://api.meta.ai/v1/asr/transcribe"


def asr(wav: bytes) -> str:
    """Meta ASR; the wav is re-wrapped to 16 kHz mono s16 as the endpoint wants (memory: meta-asr-endpoint)."""
    with wave.open(io.BytesIO(wav)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16 kHz mono s16"
    b = "dreamer" + uuid.uuid4().hex
    req = json.dumps({"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "sampleRateHertz": 16000})
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"request\"\r\nContent-Type: application/json\r\n\r\n{req}\r\n"
            f"--{b}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n").encode() \
        + wav + f"\r\n--{b}--\r\n".encode()
    r = urllib.request.Request(ASR_URL, data=body, headers={"Authorization": "Bearer " + keys.get("META"),
                                                            "Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(r, timeout=60) as resp:
        return (json.loads(resp.read()).get("transcript") or "").strip()


def make_handler(run: Path):
    dist = run / "world" / "dist"
    jobs = {}

    class H(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            b = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def _file(self, p: Path):
            if not p.is_file():
                return self.send_error(404)
            b = p.read_bytes()
            if p.name == "index.html" and p.parent == dist:
                b = b.replace(b"</body>", b'<script type="module" src="/host/dictate.js"></script>\n</body>')
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(p.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path.startswith("/host/"):
                return self._file(HOST_DIR / path[6:])
            if path.startswith("/parts/"):
                return self._file(run / path.lstrip("/"))
            if path.startswith("/part/"):
                wid = path[6:]
                part = run / "parts" / wid
                lines = (part / "progress.jsonl").read_text().splitlines() if (part / "progress.jsonl").exists() else []
                last = json.loads(lines[-1]) if lines else {"pct": 0, "stage": "queued"}
                box = json.loads((part / "box.json").read_text()) if (part / "box.json").exists() else None
                return self._json({"id": wid, "box": box, "progress": last, "ready": last.get("stage") == "done",
                                   "failed": last.get("stage") == "failed", "text": jobs.get(wid, {}).get("text")})
            if path == "/frame.json":
                return self._file(run / "frame.json")
            rel = path.lstrip("/") or "index.html"
            return self._file(dist / rel)

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n)
            if self.path == "/asr":
                t = time.time()
                try:
                    text = asr(body)
                except Exception as e:
                    return self._json({"error": str(e)[:200]}, 500)
                return self._json({"text": text, "s": round(time.time() - t, 2)})
            if self.path == "/wish":
                text = (json.loads(body or b"{}").get("text") or "").strip()
                if not text:
                    return self._json({"error": "empty wish"}, 400)
                wid = "w" + time.strftime("%H%M%S")
                jobs[wid] = {"text": text}
                threading.Thread(target=shop.build_wish, args=(text, run, wid), daemon=True).start()
                return self._json({"id": wid})
            self.send_error(404)

    return H


def warm():
    """keep one SAM3D container up for the session (cold start is ~2 min of the bar)"""
    try:
        from pipe2.assets import MESH_APPS
        from pipe2.gpu import ModalAutoscaler
        a = ModalAutoscaler(*MESH_APPS["sam3d"])
        a.set(1, 0, 300)
        atexit.register(lambda: a.set(0, 0, 120))
        print("sam3d: 1 warm container until the server stops")
    except Exception as e:
        print("warm failed:", e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--warm", action="store_true")
    a = ap.parse_args()
    run = Path(a.run).resolve()
    if a.warm:
        threading.Thread(target=warm, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(run))
    print(f"http://localhost:{a.port}/")
    srv.serve_forever()


if __name__ == "__main__":
    main()
