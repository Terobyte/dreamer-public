import os
import sys
import types
import socket
import threading
import time
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path

# stub heavy deps before importing server
os.environ.setdefault("META_MODEL_API_KEY", "dummy")
sys.path.insert(0, str(Path(__file__).resolve().parent))
gt = types.ModuleType("gate_test")
gt.OPEN = "<open>"
gt.SQUIDWARD_VOICE = "v"
gt.fish_key = lambda: "dummy"
gt.chat = lambda *a, **k: ("hi", 0, None)
sys.modules.setdefault("gate_test", gt)
lt = types.ModuleType("load_test")
lt.SQUIDWARD_LOAD = "load"
sys.modules.setdefault("load_test", lt)

from server import Handler


def _start_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


def _raw_request(port, raw: bytes) -> bytes:
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        s.sendall(raw)
        s.settimeout(3)
        data = b""
        try:
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
        except socket.timeout:
            pass
        return data
    finally:
        s.close()


def test_asr_bad_content_length_returns_http_status():
    srv = _start_server()
    try:
        port = srv.server_address[1]
        host = f"127.0.0.1:{port}"
        raw = (f"POST /asr HTTP/1.1\r\nHost: {host}\r\nContent-Length: abc\r\nConnection: close\r\n\r\nhello").encode()
        resp = _raw_request(port, raw)
        # contract: bad body gets an answer (400 or 502), not a dead socket
        assert resp.startswith(b"HTTP/"), f"dead socket, no HTTP response: {resp!r}"
        status = resp.split(b"\r\n", 1)[0]
        assert b" 400" in status or b" 502" in status, f"expected 400/502, got: {status!r}"
    finally:
        srv.shutdown()
        srv.server_close()


def test_asr_transcribe_http_error_returns_http_status():
    import server as sv
    orig = sv.transcribe

    def boom(wav):
        raise urllib.error.HTTPError("https://api.meta.ai/v1/asr/transcribe", 400, "Bad Request", {}, None)
    sv.transcribe = boom
    srv = _start_server()
    try:
        port = srv.server_address[1]
        host = f"127.0.0.1:{port}"
        body = b"RIFF....WAVEfakex"
        raw = (f"POST /asr HTTP/1.1\r\nHost: {host}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
        resp = _raw_request(port, raw)
        assert resp.startswith(b"HTTP/"), f"dead socket, no HTTP response: {resp!r}"
        status = resp.split(b"\r\n", 1)[0]
        assert b" 400" in status or b" 502" in status, f"expected 400/502, got: {status!r}"
    finally:
        sv.transcribe = orig
        srv.shutdown()
        srv.server_close()
