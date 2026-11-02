"""B60: POST /turn with a failing upstream chat() must answer HTTP and not corrupt history."""
import os
import sys
import socket
import threading
import types
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("META_MODEL_API_KEY", "dummy")
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "h0" / "live"))
gt = types.ModuleType("gate_test")
gt.OPEN = "<open>"
gt.SQUIDWARD_VOICE = "v"
gt.fish_key = lambda: "dummy"
gt.chat = lambda *a, **k: ("hi", 0, None)
sys.modules.setdefault("gate_test", gt)
lt = types.ModuleType("load_test")
lt.SQUIDWARD_LOAD = "load"
sys.modules.setdefault("load_test", lt)

import server as sv  # noqa: E402


def test_turn_upstream_error_returns_http_status_and_keeps_history():
    def boom(*a, **k):
        raise urllib.error.HTTPError("https://api.meta.ai/v1/chat/completions", 500, "err", {}, None)
    orig = sv.chat
    sv.chat = boom
    sv.history.clear()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), sv.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        port = srv.server_address[1]
        body = b'{"progress": 10, "text": "hello"}'
        raw = (f"POST /turn HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {len(body)}\r\n"
               f"Connection: close\r\n\r\n").encode() + body
        s = socket.create_connection(("127.0.0.1", port), timeout=5)
        s.sendall(raw)
        s.settimeout(3)
        data = b""
        try:
            while True:
                c = s.recv(4096)
                if not c:
                    break
                data += c
        except socket.timeout:
            pass
        s.close()
        assert data.startswith(b"HTTP/"), f"expected: HTTP 502 answer; actual: dead socket {data!r}"
        assert b" 502" in data.split(b"\r\n", 1)[0], f"expected 502, got {data[:40]!r}"
        assert sv.history == [], f"expected: user message rolled back; actual history={sv.history!r}"
    finally:
        sv.chat = orig
        sv.history.clear()
        srv.shutdown()
        srv.server_close()
