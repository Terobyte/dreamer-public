"""The one HTTP client for Meta / Baseten / Fish chat-style calls (lesson L71).

post(url, auth, payload, timeout, retries) -> {content, usage, raw}. Only the exact HTTPS
hosts below are reachable; any other host is refused before the network, redirects to
another host are not followed, so the Authorization header never leaves the list.
Error text never carries a key-like token or the raw body."""
import http.client
import json
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

ALLOWED_HOSTS = ("api.meta.ai", "inference.baseten.co", "api.fish.audio")
MAX_ATTEMPTS = 3
HEAD_CHARS = 200
_PAID_MODEL = re.compile(r"^muse-spark-1\.3$")
_TOKEN = re.compile(r"[A-Za-z0-9_\-+/=.]{20,}|sk-[A-Za-z0-9_\-]{4,}")
_REAL_URLOPEN = urllib.request.urlopen


class TransportError(Exception):
    """A failed HTTP exchange. `retryable` is decided here, not by the caller."""

    def __init__(self, message="", status=None, retryable=False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


def backoff(n):
    """Pause in seconds before retry number n (0-based)."""
    return min(2.0 * (2 ** n), 30.0)


def _sleep(seconds):
    time.sleep(seconds)


def redact(text):
    return _TOKEN.sub("[x]", text)


def _head(raw):
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    return redact(text)[:HEAD_CHARS]


def _check_host(url):
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username is not None or host not in ALLOWED_HOSTS:
        raise TransportError("host not allowed: %s" % (parts.hostname or "?"), None, False)
    return host


class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        orig = urllib.parse.urlsplit(req.full_url)
        dest = urllib.parse.urlsplit(newurl)
        if dest.scheme != "https" or (dest.hostname or "").lower() != (orig.hostname or "").lower():
            raise TransportError("redirect to another host refused", code, False)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SameHostRedirect)


def _open(req, timeout):
    opener = urllib.request.urlopen
    # stdlib urlopen has co_name "urlopen"; mocks/lambdas in tests do not.
    # Using code inspection survives late import after a test has patched urlopen.
    try:
        is_real = getattr(opener, "__code__", None) is not None and opener.__code__.co_name == "urlopen"
    except Exception:
        is_real = False
    if is_real:
        return _OPENER.open(req, timeout=timeout)
    return opener(req, timeout=timeout)


def _parse(raw):
    text = raw.decode("utf-8")
    if text.lstrip().startswith("data:"):  # SSE body
        out, usage = "", {}
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            data = json.loads(line[5:])
            usage = data.get("usage") or usage
            for ch in data.get("choices", []):
                out += (ch.get("delta") or {}).get("content") or ""
        return {"choices": [{"message": {"content": out}}], "usage": usage}
    return json.loads(text)


def _once(url, auth, payload, timeout):
    req = urllib.request.Request(
        url, json.dumps(payload).encode(),
        {"Authorization": auth, "Content-Type": "application/json"})
    try:
        with _open(req, timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read()
        except Exception:
            body = b""
        status = exc.code
        raise TransportError(("http %s %s" % (status, _head(body))).strip(), status,
                             status == 429 or 500 <= status <= 599) from None
    except TransportError:
        raise
    except (socket.timeout, TimeoutError, ConnectionError, http.client.IncompleteRead) as exc:
        raise TransportError(type(exc).__name__, None, True) from None
    except urllib.error.URLError as exc:
        retryable = isinstance(exc.reason, (socket.timeout, TimeoutError, ConnectionError))
        raise TransportError(type(exc).__name__, None, retryable) from None
    except Exception as exc:
        raise TransportError(type(exc).__name__, None, False) from None
    try:
        data = _parse(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise TransportError("bad json: %s" % type(exc).__name__, None, False) from None
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        raise TransportError("no choices: %s" % _head(raw), 200, False)
    first = choices[0] or {}
    parts = [first.get(k) or {} for k in ("message", "delta")] if isinstance(first, dict) else []
    if not parts or not all(isinstance(x, dict) for x in parts):
        raise TransportError("malformed choice: %s" % _head(raw), 200, False)
    content = parts[0].get("content") or parts[1].get("content") or ""
    if not isinstance(content, str):
        raise TransportError("content is %s, not str" % type(content).__name__, 200, False)
    return {"content": content, "usage": data.get("usage") or {}, "raw": data}


def post(url, auth, payload, timeout, retries):
    """POST JSON; retry 429/5xx up to MAX_ATTEMPTS in total (`retries` caps it lower)."""
    host = _check_host(url)
    if host == "api.meta.ai" and _PAID_MODEL.match(str(payload.get("model", "")).strip().lower()):
        raise TransportError("paid model refused: use the contributor model", None, False)
    attempts = max(1, min(int(retries) + 1, MAX_ATTEMPTS))
    for n in range(attempts):
        try:
            return _once(url, auth, payload, timeout)
        except TransportError as exc:
            if not exc.retryable or n == attempts - 1:
                raise
            _sleep(backoff(n))
