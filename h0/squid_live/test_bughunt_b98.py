"""B98: reject negative Content-Length promptly instead of blocking in read(-1)."""
import json
import socket
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402


def _request(raw, timeout):
    client, accepted = socket.socketpair()
    port = 8790
    client.settimeout(timeout)  # explicit hard bound for the negative-length hang

    def serve():
        try:
            server.Handler(accepted, ("127.0.0.1", 12345), SimpleNamespace(server_address=("127.0.0.1", port)))
        except Exception:
            pass  # the peer closes after the hard timeout; preserve the response observed before that

    worker = threading.Thread(
        target=serve,
        daemon=True,
    )
    worker.start()
    try:
        client.sendall(raw)
        data = bytearray()
        while True:
            try:
                chunk = client.recv(4096)
            except (TimeoutError, OSError):
                break
            if not chunk:
                break
            data.extend(chunk)
        first = bytes(data).split(b"\r\n", 1)[0]
        return int(first.split()[1]) if first.startswith(b"HTTP/") else "socket timeout/no response"
    finally:
        client.close()
        accepted.close()
        worker.join(timeout=0.1)


def test_negative_content_length_is_rejected_with_400(monkeypatch):
    monkeypatch.setattr(server, "think", lambda msgs: ("none", "stay", "", "hello", "fake"))
    monkeypatch.setattr(server, "speak", lambda line: None)
    port = 8790
    # Control: valid content length and trusted local headers take the ordinary route.
    body = json.dumps({"text": "hello", "history": []}).encode()
    request = (f"POST /api/talk HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {len(body)}\r\n"
               "Connection: close\r\n\r\n").encode() + body
    assert _request(request, 0.5) == 200

    # Send no body and keep the socket open until its hard timeout bounds read(-1).
    bad = (f"POST /api/talk HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: -1\r\n"
           "Connection: close\r\n\r\n").encode()
    actual = _request(bad, 0.15)
    assert actual == 400, f"expected: HTTP 400 for negative Content-Length; actual: {actual}"


def test_l71_think_goes_through_llm_http(monkeypatch):
    """L71: the duo page's Spark call is the shared client (paid-model guard, keys), not its own urllib."""
    llm_http = server._shared()[1]
    seen = []
    monkeypatch.setattr(server, "_key", lambda n: "k" if n == "META" else "")
    monkeypatch.setattr(llm_http, "post", lambda url, auth, body, t, r: seen.append((url, body["model"])) or
                        {"content": '{"gesture": "none", "action": "stay", "place": "", "line": "Hm."}'})
    g, act, place, line, model = server.think([{"role": "user", "content": "hi"}])
    assert line == "Hm." and model == server.META_MODEL
    assert seen == [(server.META_API, "muse-spark-1.3-contributor")]
