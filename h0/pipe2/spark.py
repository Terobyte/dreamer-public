"""Spark client: one call = one Answer. Transport is injected, so tests stay offline.

Unlike v1 this never raises on a bad answer: a call either returns a valid Answer with
a parsed scene, or an invalid one the caller turns into "keep the last green version".
"""

import http.client
import json
import random
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol

URL = "https://api.meta.ai/v1/chat/completions"
MODEL = "muse-spark-1.3"
MAX_TOKENS = 64000
POST_TIMEOUT_S = 1800.0
MAX_RETRIES = 2
CHARS_PER_TOKEN = 3
TOKENS_PER_IMAGE = 1500
RETRY_BASE_S = 20
RETRY_JITTER_S = 5


class TransportError(Exception):
    """A failed HTTP exchange. `retryable` is decided by the transport, not by Spark."""

    def __init__(self, message="", status=None, retryable=False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class Transport(Protocol):
    def post(self, body: dict, timeout: float) -> dict:
        """Raw parsed JSON of /v1/chat/completions, or TransportError."""


class HttpTransport:
    """Live transport. Always targets the fixed Meta endpoint - the caller cannot
    redirect it, so the API key can never be sent anywhere else. Reads the key per
    post, never stores or logs it."""

    def post(self, body, timeout):
        import os

        req = urllib.request.Request(
            URL, json.dumps(body).encode(),
            {"Authorization": "Bearer " + os.environ["META_MODEL_API_KEY"], "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            status = exc.code
            raise TransportError(f"http {status}", status,
                                 status == 429 or 500 <= status <= 599) from None
        except (socket.timeout, TimeoutError, ConnectionError) as exc:  # socket timeout / connection break
            raise TransportError(type(exc).__name__, None, True) from None
        except urllib.error.URLError as exc:  # e.g. "unknown url type" - not transient
            retryable = isinstance(exc.reason, (socket.timeout, TimeoutError, ConnectionError))
            raise TransportError(type(exc).__name__, None, retryable) from None
        except http.client.IncompleteRead as exc:  # connection broke mid-body - a connection break
            raise TransportError(type(exc).__name__, None, True) from None
        except http.client.HTTPException as exc:  # other protocol-level error, not transient
            raise TransportError(type(exc).__name__, None, False) from None
        except Exception as exc:
            raise TransportError(type(exc).__name__, None, False) from None
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise TransportError(f"bad json: {exc}", None, False) from None


@dataclass
class Answer:
    text: str = ""
    finish_reason: str | None = None
    usage: dict = field(default_factory=dict)
    latency_s: float = 0.0
    valid: bool = False
    scene: dict | None = None
    error: str | None = None


def parse_scene(text: str) -> dict:
    """Last ```json block, else the first `{`. Any failure is a ValueError."""
    marker = text.rfind("```json")
    body = text[marker + len("```json"):] if marker >= 0 else text[text.find("{"):]
    body = body.strip()
    if not body.startswith("{"):
        raise ValueError("no json object in answer")
    try:
        scene, _ = json.JSONDecoder().raw_decode(body)
    except json.JSONDecodeError as exc:
        raise ValueError(f"bad json: {exc.msg}") from None
    if not isinstance(scene, dict):
        raise ValueError("json is not an object")
    return scene


def text_chars(messages: list) -> int:
    """Characters of prompt text. Base64 image payloads are deliberately not counted:
    they are megabytes of characters but only ~TOKENS_PER_IMAGE tokens."""
    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            total += len(content)
            continue
        for part in content or ():
            if isinstance(part, dict) and part.get("type") == "text":
                total += len(part.get("text") or "")
    return total


def n_images(messages: list) -> int:
    return sum(1 for message in messages
               for part in (message.get("content") or ()) if isinstance(part, dict)
               and part.get("type") == "image_url")


def reserve_of(messages: list) -> int:
    """Pessimistic token bound for one call: prompt + the whole output ceiling."""
    return (text_chars(messages) // CHARS_PER_TOKEN
            + TOKENS_PER_IMAGE * n_images(messages) + MAX_TOKENS)


def _usage_of(raw: dict) -> dict:
    usage = raw.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    return {"prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "reasoning_tokens": details.get("reasoning_tokens", usage.get("reasoning_tokens", 0))}


class Spark:
    def __init__(self, transport, ledger, *, model=MODEL, clock=time.time, sleep=time.sleep,
                 jitter=lambda: random.uniform(0, RETRY_JITTER_S)):
        self.transport = transport
        self.ledger = ledger
        self.model = model
        self.clock = clock
        self.sleep = sleep
        self.jitter = jitter

    def ask(self, role: str, room: str, round_no: int, messages: list, effort: str) -> Answer:
        # One reserve per ask, retries included: the token cap must bound the call, not
        # each attempt. Released by the `settle` below whatever the answer turns out to be.
        reserve = reserve_of(messages)
        # B40: the known prompt is priced too, not only the output ceiling
        estimate = self.ledger.cost_of("spark", {"effort": effort, "in": reserve - MAX_TOKENS,
                                                 "out": MAX_TOKENS})
        if not self.ledger.allow("spark", estimate, reserve_tokens=reserve):
            return Answer(valid=False, error="cap")
        actual = reserve
        try:
            body = {"model": self.model, "reasoning_effort": effort,
                    "max_tokens": MAX_TOKENS, "messages": messages}
            started = self.clock()
            usages = []
            raw, error = self._post(body, usages)
            answer = Answer(latency_s=self.clock() - started, error=error)
            if raw is not None:
                self._fill(answer, raw)
            self._record(answer, role, room, round_no, effort, estimate)
            if usages:  # no usage from any attempt -> the reserve is the best guess
                actual = sum(u.get("prompt_tokens", 0) + u.get("completion_tokens", 0)
                             for u in usages)
            return answer
        finally:
            self.ledger.settle(reserve, actual)

    def _post(self, body, usages) -> tuple[Any, str | None]:
        for attempt in range(MAX_RETRIES + 1):
            try:
                raw = self.transport.post(body, POST_TIMEOUT_S)
                usage = raw.get("usage") if isinstance(raw, dict) else None
                if isinstance(usage, dict):
                    usages.append(usage)
                return raw, None
            except TransportError as exc:
                if not exc.retryable or attempt == MAX_RETRIES:
                    return None, f"transport {exc.status}: {exc}"
                self.sleep(RETRY_BASE_S * (attempt + 1) + self.jitter())
        return None, "transport: unreachable"

    def _fill(self, answer, raw):
        choice = (raw.get("choices") or [{}])[0]
        answer.text = (choice.get("message") or {}).get("content") or ""
        answer.finish_reason = choice.get("finish_reason")
        answer.usage = _usage_of(raw)
        if answer.finish_reason != "stop":
            answer.error = f"finish_reason={answer.finish_reason}"
            return
        try:
            answer.scene = parse_scene(answer.text)
        except ValueError as exc:
            answer.error = str(exc)
            return
        answer.valid = True

    def _record(self, answer, role, room, round_no, effort, reserved):
        usage = answer.usage
        cost = self.ledger.charge("spark", {"effort": effort,
                                            "in": usage.get("prompt_tokens", 0),
                                            "out": usage.get("completion_tokens", 0)},
                                  reserved=reserved)
        self.ledger.record({"kind": "spark", "role": role, "room": room, "round": round_no,
                            "effort": effort, "latency_s": answer.latency_s,
                            "prompt_tokens": usage.get("prompt_tokens", 0),
                            "completion_tokens": usage.get("completion_tokens", 0),
                            "reasoning_tokens": usage.get("reasoning_tokens", 0),
                            "finish_reason": answer.finish_reason, "valid": answer.valid,
                            "cost_usd": cost, "error": answer.error})
