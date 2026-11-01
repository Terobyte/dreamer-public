"""Fish voice: wav length from header, 3-retries fallback to silent line (spec 5-6, 13).
usage: cd h0/dream && python3 -m unittest test_media -q
"""

import json
import os
import re
import struct
import urllib.error
import urllib.request
import wave

try:
    from clock import Clock
except ImportError:
    from .clock import Clock

try:
    from llm import charge_fish
except ImportError:
    from .llm import charge_fish

FISH_API = "https://api.fish.audio/v1/tts"
TIMEOUT = 15
RETRIES = 4  # one request + up to three retries (spec 6/13)
# drama-3 hears [voice directions] and <emphasis> tags; s2-pro mostly reads past
# body remarks like [hands up] (roof run, Oct 28). Proven in h0/gate_test.py.
MODEL = "drama-3"
POOL = ("old_woman", "old_man", "woman", "man", "child", "creature")


def strip_tags(text):
    """Remove [...] and <...> tags (spec 6: fallback pause counts words without tags)."""
    s = re.sub(r"\[\[.*?\]\]", " ", text or "")
    s = re.sub(r"\[[^\]]*\]", " ", s)
    s = re.sub(r"<[^>]*>", " ", s)
    return s


def text_pause(clean_text):
    """Fallback pause for a silent line (spec 5): words / 2.5 + 1 s."""
    return len((clean_text or "").split()) / 2.5 + 1.0


def wav_seconds(path):
    """Line duration from the wav header (spec 6), no ffprobe. Fish streams
    wav with placeholder 0xFFFFFFFF chunk sizes, so the frame count lies:
    fall back to (file size - 44) / byte rate for a plain PCM header."""
    with wave.open(path, "rb") as w:
        rate = w.getframerate() or 1
        n = w.getnframes()
        if n <= 0 or n > 1 << 30:
            size = os.path.getsize(path)
            n = max(0, (size - 44) // max(1, w.getnchannels() * w.getsampwidth()))
        return n / float(rate)


def _write_silent_wav(path, seconds, rate=8000):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    n = max(1, int(seconds * rate))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % n, *[0] * n))


def fish_key():
    """FISH_AUDIO_API_KEY from env, else meta/.env (via keys.get)."""
    import sys
    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
    import keys
    return keys.get("FISH")


CHARACTERS = {"spongebob": "SPONGEBOB_VOICE", "squidward": "SQUIDWARD_VOICE"}
CHARACTER_IDS = {"spongebob": "0051da373e0a4ac282399909d1d31b69",
                 "squidward": "549dc86f83e44b0fa15f6c0842486178"}


def character_reference_id(label):
    """Fish voice of a named character (spec 6): a profile hero like SpongeBob
    has a voice of his own, not the generic pool "man". gate_test.py reads
    META_MODEL_API_KEY and its bible json at import, so it is imported lazily
    and its ids stay mirrored here for the offline path."""
    attr = CHARACTERS.get(label)
    if not attr:
        return None
    try:
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
        import gate_test
        return getattr(gate_test, attr, None) or CHARACTER_IDS[label]
    except Exception:
        return CHARACTER_IDS[label]


def load_pool(path=None):
    """{label: reference_id} for the 6 spec labels (spec 6)."""
    p = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except OSError:
        return {}


def real_transport(text, reference_id, out_path, model=MODEL):
    """One Fish TTS call asking for wav (spec 6); raises on timeout/HTTP."""
    key = fish_key()
    if not key:
        raise RuntimeError("FISH_AUDIO_API_KEY is not set")
    body = json.dumps({"text": text, "reference_id": reference_id,
                       "format": "wav"}).encode()
    req = urllib.request.Request(
        FISH_API, body,
        {"Authorization": "Bearer " + key, "Content-Type": "application/json",
         "model": model})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = r.read()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(data)
    charge_fish(text, model=model)
    return out_path


def fake_transport(text, reference_id, out_path, model=MODEL):
    """Offline stand-in: writes a wav as long as the text fallback pause."""
    _write_silent_wav(out_path, text_pause(strip_tags(text)))
    return out_path


class Voice:
    """Fish voice with retries; failures give a silent line, never stop the dream."""

    def __init__(self, transport=None, clock=None, pool=None):
        self.transport = transport or real_transport
        self.clock = clock or Clock(speed=1.0)
        self.pool = pool if pool is not None else load_pool()

    def reference_id(self, label):
        """Known label -> Fish reference_id; an unknown label (e.g. a stray
        character name from a profile) must never be forwarded to Fish as a
        literal reference_id (spec 6/13) -- fall back to the pool's "man" voice."""
        if isinstance(self.pool, dict) and label in self.pool:
            v = self.pool[label]
            return v.get("reference_id", v) if isinstance(v, dict) else v
        char = character_reference_id(label)
        if char:
            return char
        if isinstance(self.pool, dict) and "man" in self.pool:
            return self.reference_id("man")
        return label

    def synthesize(self, text, label, out_path, model=MODEL):
        """Returns {ok, audio|None, pause, diagnostic}; pause is wav length or
        tag-free text timing, so the caller always has a slot (spec 5)."""
        ref = self.reference_id(label)
        err = None
        for attempt in range(RETRIES):
            try:
                self.transport(text, ref, out_path, model) if (
                    getattr(self.transport, "__code__", None) is not None and
                    "model" in getattr(self.transport, "__code__", {}).co_varnames
                ) else self.transport(text, ref, out_path)
                seconds = wav_seconds(out_path)
                return {"ok": True, "audio": out_path, "pause": seconds,
                        "diagnostic": None, "seconds": seconds}
            except Exception as e:
                err = e
                code = getattr(e, "code", None)
                reason = getattr(e, "reason", None)
                wrapped_timeout = isinstance(reason, TimeoutError) or (
                    isinstance(reason, OSError) and "timed out" in str(reason).lower())
                retryable = (isinstance(e, TimeoutError) or wrapped_timeout
                             or code in (429, 408, 500, 502, 503))
                if not retryable or attempt == RETRIES - 1:
                    break
                try:
                    self.clock.sleep(min(2.0, 0.05 * (attempt + 1)))
                except Exception:
                    break
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass
        pause = text_pause(strip_tags(text))
        diag = {"type": "tts_fail", "error": "%s: %s" % (type(err).__name__, err)}
        return {"ok": False, "audio": None, "pause": pause, "diagnostic": "tts_fail",
                "error": diag}
