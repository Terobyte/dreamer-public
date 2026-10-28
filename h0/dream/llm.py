"""LLM wrapper: role routing, retries, money counter (spec sections 6, 13).
usage: llm.call("hero", system, messages, max_tokens=300, fake=True)
"""

import datetime
import json
import math
import os
import time
import urllib.request

SPARK_MODEL = "muse-spark-1.3"
WONDER_MODEL = "muse-wonder-1.0"

# Prices checked 2026-10-27, one verifiable source per service:
# - Muse Spark 1.3 ($1.25/$4.25 per 1M in/out) and Muse Wonder 1.0
#   ($4/$20 per 1M in/out): Meta, https://dev.meta.ai/docs/pricing-rate-limits
# - Muse Image ($0.01/pic): Meta, https://dev.meta.ai/docs/pricing-rate-limits
# - Fish Audio s2-pro ($15 per 1M UTF-8 bytes) and drama-3 ($10 per 1M
#   UTF-8 bytes promotional until 2026-11-12 17:00 UTC, $50 list after):
#   https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits
# Reconcile with usage.prompt_tokens on step 2 before any paid run.
SPARK_IN_PER_M = 1.25
SPARK_OUT_PER_M = 4.25
WONDER_IN_PER_M = 4.0
WONDER_OUT_PER_M = 20.0
FISH_PER_1M_BYTES = 15.0
FISH_S2PRO_PER_1M_BYTES = 15.0
FISH_DRAMA3_PROMO_PER_1M_BYTES = 10.0  # until 2026-11-12 17:00 UTC
FISH_DRAMA3_LIST_PER_1M_BYTES = 50.0
DRAMA3_PROMO_END = datetime.datetime(2026, 11, 12, 17, 0,
                                     tzinfo=datetime.timezone.utc)
FISH_PER_1K_CHARS = FISH_PER_1M_BYTES / 1000.0  # per 1K UTF-8 bytes
IMAGE_PER_PIC = 0.01
PRICE_SOURCES = {
    SPARK_MODEL: "2026-10-27 https://dev.meta.ai/docs/pricing-rate-limits",
    WONDER_MODEL: "2026-10-27 https://dev.meta.ai/docs/pricing-rate-limits",
    "fish": "2026-10-27 https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits",
    "fish-s2-pro": "2026-10-27 https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits",
    "fish-drama-3": "2026-10-27 https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits",
    "muse-image": "2026-10-27 https://dev.meta.ai/docs/pricing-rate-limits",
}
META_API = "https://api.meta.ai/v1/chat/completions"
SPARK_MIN_TOKENS = 300

# Role -> (model, effort). Spark 1.3 is never low (5/11 empties in probes).
ROLE_TABLE = {
    "hero": (SPARK_MODEL, "minimal"),
    "actor": (SPARK_MODEL, "minimal"),
    "compress": (SPARK_MODEL, "minimal"),
    "judge": (SPARK_MODEL, "medium"),
    "director": (WONDER_MODEL, "low"),
    "shadow": (WONDER_MODEL, "low"),
}

_spent = {0: 0.0}


def reset_spent():
    _spent[0] = 0.0


def get_spent():
    return _spent[0]


def _as_utc(when):
    """datetime/date/ISO str/None(now) -> aware UTC datetime; dates are 00:00 UTC."""
    if when is None:
        return datetime.datetime.now(datetime.timezone.utc)
    if isinstance(when, str):
        when = (datetime.datetime.fromisoformat(when) if "T" in when or " " in when
                else datetime.date.fromisoformat(when[:10]))
    if not isinstance(when, datetime.datetime):
        when = datetime.datetime(when.year, when.month, when.day)
    if when.tzinfo is None:
        when = when.replace(tzinfo=datetime.timezone.utc)
    return when.astimezone(datetime.timezone.utc)


def charge_fish(text_or_bytes, model="s2-pro", when=None):
    """Charge Fish TTS by UTF-8 bytes into the shared counter (section 13).

    Accepts the reply text (counted as UTF-8 bytes) or a byte/char count.
    The rate is picked by model: s2-pro is $15 per 1M UTF-8 bytes,
    drama-3 is $10 per 1M until 2026-11-12 17:00 UTC, then $50 per 1M list.
    `when` is the effective moment (ISO str, datetime, date, or None=now).
    """
    if isinstance(text_or_bytes, str):
        n_bytes = len(text_or_bytes.encode("utf-8"))
    else:
        n_bytes = max(0, int(text_or_bytes))
    name = str(model or "").lower()
    if "drama" in name:
        rate = (FISH_DRAMA3_PROMO_PER_1M_BYTES if _as_utc(when) < DRAMA3_PROMO_END
                else FISH_DRAMA3_LIST_PER_1M_BYTES)
    else:
        rate = FISH_S2PRO_PER_1M_BYTES
    dollars = n_bytes / 1000000.0 * rate
    _spent[0] += dollars
    return dollars


def charge_image(n=1):
    """Charge Muse Image pictures into the shared run counter (spec section 13)."""
    dollars = max(0, n) * IMAGE_PER_PIC
    _spent[0] += dollars
    return dollars


def resolve(role):
    return ROLE_TABLE.get(role, (SPARK_MODEL, "minimal"))


def _tokens(text):
    return math.ceil(len(text) / 3.5)


def _price(model, prompt_tok, completion_tok):
    if model.startswith("muse-spark"):
        rate = (SPARK_IN_PER_M, SPARK_OUT_PER_M)
    else:
        rate = (WONDER_IN_PER_M, WONDER_OUT_PER_M)
    return (prompt_tok * rate[0] + completion_tok * rate[1]) / 1000000.0


class LlmResult:
    def __init__(self, text, usage, seconds, dollars):
        self.text = text
        self.usage = usage
        self.seconds = seconds
        self.dollars = dollars


def _prompt_text(system, messages):
    parts = [system or ""]
    for m in messages or []:
        parts.append(m.get("content", "") if isinstance(m, dict) else str(m))
    return "\n".join(parts)


def _real_complete(model, effort, system, messages, max_tokens):
    """Real Meta Muse API call (gate_test.py pattern, lazy key, stdlib only)."""
    key = os.environ.get("META_MODEL_API_KEY")
    if not key:
        raise RuntimeError("META_MODEL_API_KEY is not set")
    body = {"model": model, "reasoning_effort": effort,
            "max_tokens": max_tokens, "stream": False,
            "messages": [{"role": "system", "content": system or ""},
                         *(messages or [])]}
    req = urllib.request.Request(
        META_API, json.dumps(body).encode(),
        {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read().decode()
    # Support both a plain JSON body and an SSE stream body.
    if raw.lstrip().startswith("data:"):
        text, usage = "", {}
        for line in raw.splitlines():
            line = line.strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            data = json.loads(line[5:])
            usage = data.get("usage") or usage
            for ch in data.get("choices", []):
                text += (ch.get("delta") or {}).get("content") or ""
        return {"content": text, "usage": usage}
    data = json.loads(raw)
    choices = data.get("choices") or []
    content = ""
    if choices:
        content = (choices[0].get("message") or {}).get("content") or \
            (choices[0].get("delta") or {}).get("content") or ""
    return {"content": content, "usage": data.get("usage") or {}}


def _piece_parts(piece, prompt_tok):
    """Normalise str/dict/object provider replies to (text, prompt, completion)."""
    if isinstance(piece, str):
        return piece, prompt_tok, _tokens(piece)
    if isinstance(piece, dict):
        text = piece.get("content") or piece.get("text") or ""
        usage = piece.get("usage") or {}
    else:
        text = getattr(piece, "content", None) or getattr(piece, "text", "") or ""
        usage = getattr(piece, "usage", None) or {}
    if not isinstance(usage, dict):
        usage = {"prompt_tokens": getattr(usage, "prompt_tokens", prompt_tok),
                 "completion_tokens": getattr(usage, "completion_tokens", _tokens(text))}
    return (text, int(usage.get("prompt_tokens", prompt_tok)),
            int(usage.get("completion_tokens", _tokens(text))))


def call(role, system, messages, max_tokens=300, fake=False, _transport=None):
    """Call the model for role; empty reply is retried once with a bigger limit."""
    model, effort = resolve(role)
    if model.startswith("muse-spark") and max_tokens < SPARK_MIN_TOKENS:
        max_tokens = SPARK_MIN_TOKENS
    est_prompt = _tokens(_prompt_text(system, messages))
    text, dollars = "", 0.0
    tot_p = tot_c = 0
    start = time.monotonic()
    for limit in (max_tokens, max_tokens * 2 + 100):
        if fake:
            if _transport is None:
                raise RuntimeError("fake=True needs a transport")
            piece = _transport.complete(model=model, effort=effort,
                                        system=system, messages=messages,
                                        max_tokens=limit)
        else:
            transport = _transport
            fn = (transport.complete if transport is not None else _real_complete)
            piece = fn(model=model, effort=effort, system=system,
                       messages=messages, max_tokens=limit)
        chunk, p_tok, c_tok = _piece_parts(piece, est_prompt)
        tot_p += p_tok
        tot_c += c_tok
        step = _price(model, p_tok, c_tok)
        dollars += step
        _spent[0] += step
        text = chunk
        if chunk and chunk.strip():
            break
    return LlmResult(text, {"prompt_tokens": tot_p,
                            "completion_tokens": tot_c},
                     time.monotonic() - start, dollars)
