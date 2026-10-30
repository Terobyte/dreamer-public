"""LLM wrapper: role routing, retries, money counter (spec sections 6, 13).
usage: llm.call("hero", system, messages, max_tokens=300, fake=True)
"""

import datetime
import json
import math
import os
import subprocess
import tempfile
import time
import threading
import urllib.request

if __package__:
    from .diagnostics import report
else:
    from diagnostics import report

SPARK_MODEL = "muse-spark-1.3"
SPARK_OPEN_MODEL = "meta-models/muse-spark-open-1026"
WONDER_MODEL = "muse-wonder-1.0"
# Bench r2 probe: Claude Haiku through the local Claude Code CLI on the owner's
# subscription, no API key -- price 0 here, the dollars are not Meta's to count.
CLAUDE_HAIKU_MODEL = "claude-cli/haiku"
CLAUDE_OPUS_MODEL = "claude-cli/opus"
CLAUDE_CLI_MODELS = (CLAUDE_HAIKU_MODEL, CLAUDE_OPUS_MODEL)

# Prices checked 2026-10-27, one verifiable source per service:
# - Muse Spark 1.3 ($1.25/$4.25 per 1M in/out) and Muse Wonder 1.0
#   ($4/$20 per 1M in/out): Meta, https://dev.meta.ai/docs/pricing-rate-limits
# - Muse Image ($0.01/pic): Meta, https://dev.meta.ai/docs/pricing-rate-limits
# - Fish Audio s2-pro ($15 per 1M UTF-8 bytes) and drama-3 ($10 per 1M
#   UTF-8 bytes promotional until 2026-11-12 17:00 UTC, $50 list after):
#   https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits
# - Muse Spark Open on Baseten: free on the hackathon key (owner, 2026-10-27),
#   https://inference.baseten.co/v1 -- price 0, the counter still counts it.
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
    SPARK_OPEN_MODEL: "2026-10-27 https://inference.baseten.co/v1 (hackathon key, free)",
    CLAUDE_HAIKU_MODEL: "2026-10-29 claude -p on the owner's subscription (no per-call price)",
    CLAUDE_OPUS_MODEL: "2026-10-29 claude -p on the owner's subscription (no per-call price)",
}
META_API = "https://api.meta.ai/v1/chat/completions"
BASETEN_API = "https://inference.baseten.co/v1/chat/completions"
SPARK_MIN_TOKENS = 300
# Spark Open spends reasoning inside max_tokens: 300 once came back empty
# (297 reasoning tokens, finish_reason=length), 1500 never did in 131 calls.
SPARK_OPEN_MIN_TOKENS = 1500
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")

# Role -> (model, effort). Spark roles run on Spark Open (Baseten, free); a
# failed Baseten call falls back to Spark 1.3 on Meta. Spark 1.3 is never low.
ROLE_TABLE = {
    "hero": (SPARK_OPEN_MODEL, "minimal"),
    "actor": (SPARK_OPEN_MODEL, "minimal"),
    "compress": (SPARK_OPEN_MODEL, "minimal"),
    # 3.2: without this row resolve() falls through to the paid SPARK_MODEL
    "narrator": (SPARK_OPEN_MODEL, "minimal"),
    "judge": (SPARK_OPEN_MODEL, "medium"),
    "director": (WONDER_MODEL, "low"),
    "shadow": (WONDER_MODEL, "low"),
}

# The hero (the player) runs a little hot so the dream can surprise; actors and
# the director stay at the provider default. Sent to Baseten (Spark Open) only.
ROLE_TEMPERATURE = {"hero": 1.2}

# Bench knob (design doc 2026-10-28, section 7a): who speaks for the talk roles.
# Default stays Spark Open (free); "wonder" is the paid strong model for comparison.
TALK_ROLES = ("hero", "actor", "compress")
TALK_MODELS = {"spark-open": (SPARK_OPEN_MODEL, "minimal"),
               "spark": (SPARK_MODEL, "minimal"),
               "wonder": (WONDER_MODEL, "low"),
               "haiku": (CLAUDE_HAIKU_MODEL, "minimal"),
               "opus": (CLAUDE_OPUS_MODEL, "high")}
_cap = {0: None}


_talk = {0: "spark-open"}


def set_talk_model(name):
    """Route hero/actor/compress to one of TALK_MODELS. Raises on an unknown name."""
    if name not in TALK_MODELS:
        raise ValueError("unknown talk model %r, want one of %s" % (name, sorted(TALK_MODELS)))
    for role in TALK_ROLES:
        ROLE_TABLE[role] = TALK_MODELS[name]
    _talk[0] = name


def talk_model_name():
    """The name the talk roles are routed to (the run's snapshot records it)."""
    return _talk[0]


def set_cap(dollars):
    """Hard stop for paid calls: once spent >= cap, call() answers empty instead of
    paying. Free calls keep going. None removes the cap (the default)."""
    _cap[0] = None if dollars is None else float(dollars)

_spent = {0: 0.0}
_spent_lock = threading.Lock()


def reset_spent():
    with _spent_lock:
        _spent[0] = 0.0


def get_spent():
    with _spent_lock:
        return _spent[0]


def _charge(dollars):
    with _spent_lock:
        _spent[0] += dollars


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
    _charge(dollars)
    return dollars


def charge_image(n=1):
    """Charge Muse Image pictures into the shared run counter (spec section 13)."""
    dollars = max(0, n) * IMAGE_PER_PIC
    _charge(dollars)
    return dollars


def resolve(role):
    return ROLE_TABLE.get(role, (SPARK_MODEL, "minimal"))


def _tokens(text):
    return math.ceil(len(text) / 3.5)


def _min_tokens(model):
    if model == SPARK_OPEN_MODEL:
        return SPARK_OPEN_MIN_TOKENS
    return SPARK_MIN_TOKENS if model.startswith("muse-spark") else 0


def _price(model, prompt_tok, completion_tok):
    if model == SPARK_OPEN_MODEL or model in CLAUDE_CLI_MODELS:
        return 0.0
    if model.startswith("muse-spark"):
        rate = (SPARK_IN_PER_M, SPARK_OUT_PER_M)
    else:
        rate = (WONDER_IN_PER_M, WONDER_OUT_PER_M)
    return (prompt_tok * rate[0] + completion_tok * rate[1]) / 1000000.0


class LlmResult:
    def __init__(self, text, usage, seconds, dollars, diagnostics=(), attempts=()):
        self.text = text
        self.usage = usage
        self.seconds = seconds
        self.dollars = dollars
        self.diagnostics = list(diagnostics)
        self.attempts = list(attempts)


def _prompt_text(system, messages):
    parts = [system or ""]
    for m in messages or []:
        parts.append(m.get("content", "") if isinstance(m, dict) else str(m))
    return "\n".join(parts)


def _baseten_key():
    """BASETEN_API_KEY from the environment, else from the gitignored meta/.env."""
    key = os.environ.get("BASETEN_API_KEY", "").strip()
    if key:
        return key
    try:
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("BASETEN_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


class RealTransport:
    """Provider routing with observable fallback, shared by every LLM role."""

    def __init__(self, event_sink=None):
        self.event_sink = event_sink

    def complete(self, model, effort, system, messages, max_tokens, temperature=None):
        diagnostics = []
        if model in CLAUDE_CLI_MODELS:
            return {"content": _claude_cli(model.split("/")[1], system, messages, effort),
                    "usage": {},
                    "model": model}
        if model == SPARK_OPEN_MODEL:
            key = _baseten_key()
            try:
                if not key:
                    raise RuntimeError("BASETEN_API_KEY is not set")
                out = _post(BASETEN_API, "Api-Key " + key, model, effort,
                            system, messages, max_tokens, temperature)
                out["model"] = model
                return out
            except Exception as error:
                diagnostics.append(report(
                    "llm", "llm_fallback", error, self.event_sink,
                    from_model=model, to_model=SPARK_MODEL))
            model, max_tokens = SPARK_MODEL, max(SPARK_MIN_TOKENS, max_tokens)
        key = os.environ.get("META_MODEL_API_KEY")
        if not key:
            raise RuntimeError("META_MODEL_API_KEY is not set")
        out = _post(META_API, "Bearer " + key, model, effort, system, messages, max_tokens)
        out["model"] = model
        out["diagnostics"] = diagnostics
        return out


def _claude_cli(alias, system, messages, effort="minimal"):
    """One `claude -p` call with no user settings, MCP, tools or session: the
    system prompt and the turn text are all the model sees (~2 s a call)."""
    turn = "\n\n".join(m.get("content", "") if isinstance(m, dict) else str(m)
                        for m in messages or [])
    cmd = ["claude", "-p", "--model", alias, "--strict-mcp-config", "--setting-sources", "",
           "--tools", "", "--no-session-persistence", "--system-prompt", system or ""]
    if effort in ("low", "medium", "high", "xhigh", "max"):
        cmd += ["--effort", effort]
    done = subprocess.run(cmd, input=turn, capture_output=True, text=True, timeout=120,
                          cwd=tempfile.gettempdir())
    if done.returncode != 0:
        raise RuntimeError("claude -p failed: %s" % (done.stderr or done.stdout)[-300:])
    return done.stdout.strip()


def _real_complete(model, effort, system, messages, max_tokens):
    """Real Muse call (gate_test.py pattern, lazy key, stdlib only).
    Spark Open goes to Baseten; if that fails, the call is made once on Spark 1.3 (Meta)."""
    return RealTransport().complete(model, effort, system, messages, max_tokens)


def _post(url, auth, model, effort, system, messages, max_tokens, temperature=None):
    body = {"model": model, "reasoning_effort": effort,
            "max_tokens": max_tokens, "stream": False,
            "messages": [{"role": "system", "content": system or ""},
                         *(messages or [])]}
    if temperature is not None:
        body["temperature"] = temperature
    req = urllib.request.Request(
        url, json.dumps(body).encode(),
        {"Authorization": auth, "Content-Type": "application/json"})
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


def call(role, system, messages, max_tokens=300, fake=False, _transport=None,
         event_sink=None):
    """Call the model for role; empty reply is retried once with a bigger limit."""
    model, effort = resolve(role)
    max_tokens = max(max_tokens, _min_tokens(model))
    est_prompt = _tokens(_prompt_text(system, messages))
    text, dollars = "", 0.0
    tot_p = tot_c = 0
    start = time.monotonic()
    diagnostics, attempts = [], []
    if fake and _transport is None:
        raise RuntimeError("fake=True needs a transport")
    if _cap[0] is not None and _price(model, 1, 1) > 0 and get_spent() >= _cap[0] - 1e-9:
        return LlmResult("", {"prompt_tokens": 0, "completion_tokens": 0}, 0.0, 0.0,
                         [{"type": "cap", "component": "llm", "role": role, "model": model,
                           "error": "cap $%.2f reached, paid call skipped" % _cap[0]}], [])
    transport = _transport or RealTransport(event_sink)
    for limit in (max_tokens, max_tokens * 2 + 100):
        extra = {}
        if isinstance(transport, RealTransport) and ROLE_TEMPERATURE.get(role) is not None:
            extra["temperature"] = ROLE_TEMPERATURE[role]
        piece = transport.complete(model=model, effort=effort, system=system,
                                   messages=messages, max_tokens=limit, **extra)
        chunk, p_tok, c_tok = _piece_parts(piece, est_prompt)
        tot_p += p_tok
        tot_c += c_tok
        # a Baseten failure is billed as the Meta model that answered
        used = piece.get("model", model) if isinstance(piece, dict) else model
        step = _price(used, p_tok, c_tok)
        dollars += step
        _charge(step)
        if isinstance(piece, dict):
            diagnostics.extend(piece.get("diagnostics", []))
        attempts.append({"model": used, "max_tokens": limit,
                         "prompt_tokens": p_tok, "completion_tokens": c_tok,
                         "dollars": step})
        text = chunk
        if chunk and chunk.strip():
            break
    return LlmResult(text, {"prompt_tokens": tot_p,
                            "completion_tokens": tot_c},
                     time.monotonic() - start, dollars, diagnostics, attempts)
