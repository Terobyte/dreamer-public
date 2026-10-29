"""Humanness signals (bench r2, step Ч1): where a dream reads as a model, not a person.

Free, text only, over the `line` rows of a run log. Every value is a share of
lines or a per-line rate, so runs of different length compare. The tics are the
ones a reader names first on the r1 and Ф1 sheets: every line a question, the
other's name in every line, lines all of one length with no "No." or "What.",
therapy phrases, an acquiescent opener, [pause] everywhere, the same opener again.
The cliché list is English; a Russian run scores 0 on it (bench gates are en only).
"""

import re
import statistics

from dialogue import _spoken

KEYS = ("q_share", "name_share", "short_share", "len_cv", "cliche_per_line",
        "agree_open_share", "pause_per_line", "opener_rep_share", "echo_prev", "idiolect")
SHORT_WORDS = 3
CONTENT_LEN = 4
_WORD = re.compile(r"[\w']+")
_PAUSE = re.compile(r"\[pause\]", re.I)
_TRAIL = " \"'’”)"
AGREE_OPENERS = ("okay", "ok", "alright", "yeah", "yes", "sure", "right", "fine", "look",
                 "listen", "hey", "of course", "i know", "i get it")
CLICHES = [re.compile(r"\b" + p + r"\b", re.I) for p in (
    r"i'?m right here", r"i'?m (still )?here", r"i am here", r"right here with you",
    r"i promise", r"thank you for telling me", r"you'?re not alone", r"you are not alone",
    r"it'?s (going to be |gonna be )?okay", r"we'?ll figure", r"i'?ve got you", r"i got you",
    r"take a breath", r"i hear you", r"that must('ve| have)? been", r"must('ve| have) been",
    r"i'?m not going anywhere", r"i'?m not leaving", r"stay with me", r"talk to me",
    r"you don'?t have to", r"i'?m listening", r"let me help", r"i'?m here for you",
    r"you can tell me", r"whatever you need")]


def words(text):
    return _WORD.findall(_spoken(text).lower())


def _content(ws):
    return {w for w in ws if len(w) >= CONTENT_LEN}


def _opener(ws):
    return tuple(ws[:2])


def _agree(ws):
    return bool(ws) and (ws[0] in AGREE_OPENERS or " ".join(ws[:2]) in AGREE_OPENERS)


def score_human(rows):
    """-> {KEYS: number}, every value None on a log without lines. Shares are over
    all lines; echo_prev is the mean content-word Jaccard with the previous line,
    idiolect the mean share of a speaker's content words no other speaker uses."""
    lines = [(r.get("who") or "?", r.get("text") or "") for r in rows if r.get("type") == "line"]
    n = len(lines)
    if not n:
        return {k: None for k in KEYS}
    spoken = [" ".join(_spoken(t).split()).rstrip(_TRAIL) for _, t in lines]
    ws = [words(t) for _, t in lines]
    lens = [len(w) for w in ws]
    speakers = {who.lower() for who, _ in lines}
    name_pat = {s: re.compile(r"\b" + re.escape(s) + r"\b", re.I) for s in speakers}
    named = sum(1 for (who, t), s in zip(lines, spoken)
                if any(p.search(s) for other, p in name_pat.items() if other != who.lower()))
    mean = statistics.mean(lens)
    cv = (statistics.pstdev(lens) / mean) if mean else 0.0
    seen, rep = set(), 0
    for w in ws:
        op = _opener(w)
        if op and op in seen:
            rep += 1
        seen.add(op)
    echo = []
    for a, b in zip(ws, ws[1:]):
        ca, cb = _content(a), _content(b)
        union = ca | cb
        echo.append(len(ca & cb) / len(union) if union else 0.0)
    own = {}
    for (who, _), w in zip(lines, ws):
        own.setdefault(who, set()).update(_content(w))
    distinct = []
    for who, types in own.items():
        others = set().union(*(t for w, t in own.items() if w != who)) if len(own) > 1 else set()
        if types:
            distinct.append(len(types - others) / len(types))
    return {
        "q_share": round(sum(1 for s in spoken if s.endswith("?")) / n, 3),
        "name_share": round(named / n, 3),
        "short_share": round(sum(1 for l in lens if l <= SHORT_WORDS) / n, 3),
        "len_cv": round(cv, 3),
        "cliche_per_line": round(sum(len(c.findall(s)) for s in spoken for c in CLICHES) / n, 3),
        "agree_open_share": round(sum(1 for w in ws if _agree(w)) / n, 3),
        "pause_per_line": round(sum(len(_PAUSE.findall(t)) for _, t in lines) / n, 3),
        "opener_rep_share": round(rep / n, 3),
        "echo_prev": round(statistics.mean(echo), 3) if echo else 0.0,
        "idiolect": round(statistics.mean(distinct), 3) if distinct else 0.0,
    }
