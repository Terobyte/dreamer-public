"""Delivery of book lines: one director call per scene writes each line's tone (beat["tone"], e.g.
"whispering, warm, tender"); sim voices it as a drama-3 [direction] and the subtitle keeps the book's text.
Bare text reads flat (Koshakan, Nov 2: Mama sounded dry in the engine film; the warm take of Nov 1 was
hand-made in the demo only). The answer is cached by the scene's lines, so a rebuild is free.
"""
import copy
import hashlib
import json
import os
import re

VERSION = 1
MAX_TONE = 60

PROMPT = """You direct the voice actors of a picture book read aloud. Each line below is spoken by an
expressive TTS that plays a short English direction in brackets, e.g. [softly, warmly, smiling],
[whispering, tender], [laughing, delighted, excited], [sleepy, grumbling]. For every line give its
direction: 2-4 words on emotion, volume and pace, taken from the narration around it and from who speaks
to whom. No stage actions (no "hands up"), no quotes.
Answer one JSON object: {"tones": [{"id": <line id>, "tone": "<direction>"}]}

Scene:
"""


def _lines(score):
    return [b for b in score.get("beats") or [] if b.get("kind") == "line" and isinstance(b.get("text"), str)]


def tone_prompt(score):
    rows = []
    for b in score.get("beats") or []:
        if b.get("kind") == "line":
            rows.append('line id=%s, %s: "%s"' % (b.get("id"), b.get("who") or "?", b.get("text")))
        elif isinstance(b.get("text"), str):
            rows.append("narration: %s" % b["text"])
    return PROMPT + "\n".join(rows)


def _clean(tone):
    if not isinstance(tone, str):
        return None
    t = re.sub(r"[\[\]\"<>\n]", " ", tone)
    t = " ".join(t.split()).strip(" ,.")
    return t[:MAX_TONE] or None


def _parse(raw):
    text = (raw or "").strip()
    a, z = text.find("{"), text.rfind("}")
    if a < 0 or z < a:
        raise ValueError("no JSON object")
    obj = json.loads(text[a:z + 1])
    tones = obj.get("tones") if isinstance(obj, dict) else None
    if not isinstance(tones, list):
        raise ValueError("no tones list")
    return {str(t.get("id")): _clean(t.get("tone")) for t in tones if isinstance(t, dict)}


def add_tones(score, director, cache_dir=None):
    """score -> (a copy whose line beats carry `tone`, warnings). A broken answer leaves the lines as written."""
    lines = _lines(score)
    if not lines:
        return score, []
    prompt = tone_prompt(score)
    key = hashlib.sha256(json.dumps({"v": VERSION, "prompt": prompt}, ensure_ascii=False).encode()).hexdigest()
    path = os.path.join(cache_dir, "tone-%s.json" % key) if cache_dir else None
    warnings = []
    tones = None
    if path and os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                tones = json.load(f)
            if not isinstance(tones, dict):
                raise ValueError("cache is not an object")
        except (OSError, ValueError):  # a torn file from an interrupted run: ask again
            tones = None
    if tones is None:
        try:
            tones = _parse(director(prompt))
        except Exception as e:
            warnings.append("tones: director answer unusable (%s), lines voiced as written" % e)
            tones = {}
        if path and tones:
            os.makedirs(cache_dir, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(tones, f, ensure_ascii=False)
    out = copy.deepcopy(score)
    for b in out["beats"]:
        if b.get("kind") == "line" and tones.get(str(b.get("id"))):
            b["tone"] = tones[str(b.get("id"))]
    return out, warnings
