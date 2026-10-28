"""World input: sanitize(text, speaker) and resolve_touch(value, objects) (spec section 5a).
usage: text, events = sanitize("[[TOUCH:x]] hi", "human"); obj, events = resolve_touch("the radios", objects)
"""

import re

ACTOR_TAGS = ("LOOK",)
ARTICLES = {"a", "an", "the"}

_DOUBLE = re.compile(r"\[\[[^\[\]]*\]\]")
_SINGLE = re.compile(r"\[[^\[\]]*\]")
_ANGLE = re.compile(r"<[^<>]*>")
_ENGINE = re.compile(r"\[(?:WORLD|STATE|EVENT|ENGINE|HUMAN_SAYS)\b[^\[\]]*\]")


def _cut(pattern, text, removed, keep=lambda m: False):
    def sub(m):
        if keep(m.group(0)):
            return m.group(0)
        removed.append(m.group(0))
        return " "
    return pattern.sub(sub, text)


def sanitize(text, speaker):
    """human: drop every [...], [[...]], <...>. actor: drop engine tags, foreign [[...]] and [..=..]."""
    removed = []
    if speaker == "human":
        for p in (_DOUBLE, _SINGLE, _ANGLE):
            text = _cut(p, text, removed)
    else:
        allowed = lambda s: s[2:-2].split(":")[0].strip().upper() in ACTOR_TAGS
        text = _cut(_DOUBLE, text, removed, keep=allowed)
        text = _cut(_ENGINE, text, removed)
        text = _cut(_SINGLE, text, removed,
                    keep=lambda s: "=" not in s or s.startswith("[[") or s.endswith("]]"))
    text = " ".join(text.split())
    events = [{"type": "input_rejected", "speaker": speaker, "removed": removed}] if removed else []
    return text, events


def _singular(w):
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 4 and w.endswith(("sses", "xes", "ches", "shes")):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def _words(s):
    return {_singular(w) for w in re.findall(r"[a-z0-9']+", s.lower()) if w not in ARTICLES}


def resolve_touch(value, objects):
    """Map a click/touch value to one object of the current scene, or None plus a log event."""
    v = " ".join(value.lower().split())
    for o in objects:
        if o.lower() == v:
            return o, []
    want = _words(v)
    hits = [o for o in objects if want and want <= _words(o)] if want else []
    if len(hits) == 1:
        return hits[0], []
    if hits:
        return None, [{"type": "touch_ambiguous", "value": value, "candidates": hits}]
    return None, [{"type": "touch_rejected", "value": value}]
