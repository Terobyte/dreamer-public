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
        estimate = self.ledger.cost_of("spark", {"effort": effort, "in": 0, "out": MAX_TOKENS})
        if not self.ledger.allow("spark", estimate):
            return Answer(valid=False, error="cap")
        body = {"model": self.model, "reasoning_effort": effort,
                "max_tokens": MAX_TOKENS, "messages": messages}
        started = self.clock()
        raw, error = self._post(body)
        answer = Answer(latency_s=self.clock() - started, error=error)
        if raw is not None:
            self._fill(answer, raw)
        self._record(answer, role, room, round_no, effort, estimate)
        return answer

    def _post(self, body) -> tuple[Any, str | None]:
        for attempt in range(MAX_RETRIES + 1):
            try:
                return self.transport.post(body, POST_TIMEOUT_S), None
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
