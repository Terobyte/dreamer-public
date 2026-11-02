"""Book mode, step 1: chapter text -> draft score (no LLM).
A score is a list of beats (line / narration); the owner's hand-edited score (--score) is the truth.
usage: python3 book.py <book_dir> --scene library [--out score.json] [--stats]
"""
import argparse
import json
import os
import re
import sys
from collections import Counter

try:
    from .stage_director import run_staging
except ImportError:
    from stage_director import run_staging

HERE = os.path.dirname(os.path.abspath(__file__))

SPEECH_VERBS = ["said", "asked", "cried", "whispered", "hissed", "shouted", "answered", "replied",
                "drawled", "repeated", "observed", "muttered", "called", "came the voice",
                "came a voice"]
VERB_RE = re.compile(r"\b(?:" + "|".join(SPEECH_VERBS) + r")\b")
THOUGHT_RE = re.compile(r"\b(?:thought|thinking|a memory|had said that|jibed)\b")
SENT_END = re.compile(r"(?<!\bMr)(?<!\bMrs)(?<!\bDr)(?<!\bSt)[.!?](?=\s|$)")
PRONOUN_RE = re.compile(r"\b(he|she|his|him|her)\b", re.I)
MALE = {"he", "his", "him"}

MAX_PLAIN = 60
CHUNK = 40


# ---- loading / validation --------------------------------------------------

def split_paras(text):
    return re.split(r"\n\s*\n", text.strip())


def load_book(dir):
    path = os.path.join(dir, "book.json")
    with open(path, encoding="utf-8") as f:
        book = json.load(f)
    with open(os.path.join(HERE, "voices.json"), encoding="utf-8") as f:
        voices = json.load(f)
    cast = book.get("cast") or {}
    if book.get("pov") not in cast:
        raise ValueError(f"pov: {book.get('pov')!r} not in cast")
    for name, c in cast.items():
        if c.get("voice") not in voices:
            raise ValueError(f"cast.{name}.voice: {c.get('voice')!r} not in voices.json")
    for ch in book.get("chapters", []):
        fpath = os.path.join(dir, ch.get("file", ""))
        if not os.path.isfile(fpath):
            raise ValueError(f"chapters[{ch.get('n')}].file: {ch.get('file')!r} not found")
        with open(fpath, encoding="utf-8") as f:
            n = len(split_paras(f.read()))
        taken = []
        for sc in ch.get("scenes", []):
            sid = sc.get("id")
            p = sc.get("paras")
            if not (isinstance(p, list) and len(p) == 2
                    and isinstance(p[0], int) and not isinstance(p[0], bool)
                    and isinstance(p[1], int) and not isinstance(p[1], bool)
                    and 0 <= p[0] < p[1] <= n):
                raise ValueError(f"scene {sid} paras: {p!r} outside 0 <= from < to <= {n}")
            for a, b, other in taken:
                if p[0] < b and a < p[1]:
                    raise ValueError(f"scene {sid} paras: {p!r} overlaps scene {other}")
            taken.append((p[0], p[1], sid))
            for who in sc.get("cast", []):
                if who not in cast:
                    raise ValueError(f"scene {sid} cast: {who!r} not in book cast")
            for key, who in (sc.get("aliases") or {}).items():
                if who not in sc.get("cast", []):
                    raise ValueError(f"scene {sid} aliases: {key} -> {who!r} not in scene cast")
    book["_dir"] = dir
    return book


def find_scene(book, scene_id):
    for ch in book["chapters"]:
        for sc in ch["scenes"]:
            if sc["id"] == scene_id:
                return ch, sc
    for ch in book["chapters"]:
        for sc in ch["scenes"]:
            if scene_id.startswith(sc["id"]) or sc["id"].startswith(scene_id):
                return ch, sc
    raise ValueError(f"scene: {scene_id!r} not in book")


# ---- text helpers ------------------------------------------------------------

def _words(s):
    return len(s.split())


def _split_long(sent):
    words = sent.split()
    if len(words) <= CHUNK:
        return [sent]
    # every word gap is a space boundary, so the one nearest to 40 is right at 40
    k = CHUNK
    return [" ".join(words[:k])] + _split_long(" ".join(words[k:]))


def split_narration(text):
    if _words(text) <= MAX_PLAIN:
        return [text]
    sents, last = [], 0
    for m in SENT_END.finditer(text):
        sents.append(text[last:m.end()].strip())
        last = m.end()
    if text[last:].strip():
        sents.append(text[last:].strip())
    pieces = [p for s in sents for p in _split_long(s)]
    out, cur = [], ""
    for p in pieces:
        if cur and _words(cur) + _words(p) > CHUNK:
            out.append(cur)
            cur = p
        else:
            cur = (cur + " " + p).strip()
    if cur:
        out.append(cur)
    return out


def _quote_spans(p):
    # F15: only closed quote pairs are dialogue; a lone trailing quote stays
    # narration (an unmatched `"` never opens a line beat).
    idx = [i for i, c in enumerate(p) if c == '"']
    return [(idx[k], idx[k + 1]) for k in range(0, len(idx) - 1, 2)]


def _pre_sentence(before):
    before = before.strip()
    if not before:
        return ""
    ends = [m.end() for m in SENT_END.finditer(before)]
    if ends and ends[-1] == len(before):
        ends.pop()
    return before[ends[-1]:].strip() if ends else before


def _alias_hits(text, aliases):
    """[(pos, alias_value)] in text order; `X's voice` counts, `X's <other>` does not."""
    hits = []
    for key in sorted(aliases, key=len, reverse=True):
        for m in re.finditer(r"(?<!\w)" + re.escape(key) + r"(?!\w)", text):
            rest = text[m.end():]
            if rest.startswith("'s") and not re.match(r"'s voice\b", rest):
                continue
            hits.append((m.start(), -len(key), aliases[key]))
    hits.sort()
    seen, out = set(), []
    for pos, _, who in hits:
        if pos not in seen:
            seen.add(pos)
            out.append((pos, who))
    return out


# ---- the parser ------------------------------------------------------------------

class _State:
    def __init__(self, scene, book):
        self.scene = scene
        self.cast = scene["cast"]
        self.aliases = scene.get("aliases") or {}
        self.sex = {n: book["cast"].get(n, {}).get("sex") for n in self.cast}
        self.hist = []          # non-null speakers, in order
        self.beats = []
        known = set()
        for k in list(self.aliases) + list(scene.get("extras") or []):
            known.update(re.findall(r"[A-Za-z']+", k))
        self.known = known

    def prev_line(self):
        for b in reversed(self.beats):
            if b["kind"] == "line":
                return b
        return None

    def recent_distinct(self, n=2):
        out = []
        for w in reversed(self.hist):
            if w not in out:
                out.append(w)
            if len(out) == n:
                break
        return out


def _by_pronoun(st, tag):
    m = PRONOUN_RE.search(tag)
    if not m:
        return False, None
    sex = "man" if m.group(1).lower() in MALE else "woman"
    prev = st.prev_line()
    prev_who = prev["who"] if prev else None
    same = [w for w in reversed(st.hist) if st.sex.get(w) == sex]
    for w in same:
        if w != prev_who:
            return True, w
    if same:
        return True, same[0]
    for n in st.cast:
        if st.sex.get(n) == sex:
            return True, n
    return True, None


def _from_tag(st, post, pre):
    """(decided, who) from the remark alone."""
    for part in (post, pre):
        hits = _alias_hits(part, st.aliases)
        if hits:
            return True, hits[0][1]
    tag = (pre + " " + post).strip()
    has_verb = bool(VERB_RE.search(tag))
    if has_verb:
        for m in re.finditer(r"\b[A-Z][a-z]+", tag):
            before = tag[:m.start()].rstrip()
            if before and before[-1] not in ".!?" and m.group() not in st.known and m.group() != "I":
                return True, None
    decided, who = _by_pronoun(st, post)
    if not decided:
        decided, who = _by_pronoun(st, pre)
    if decided:
        return True, who
    if has_verb:
        return True, None
    return False, None


def _by_position(st, para, before_text):
    prev = st.prev_line()
    if prev is None:
        return None
    if prev["para"] == para - 1:
        if prev["text"].rstrip().endswith("--"):
            return prev["who"]
        if prev["who"] is None:
            return None
        two = st.recent_distinct(2)
        others = [w for w in two if w != prev["who"]]
        return others[0] if len(two) == 2 and others else None
    idx = max(i for i, b in enumerate(st.beats) if b is prev)
    between = " ".join(_drop_tag(b["text"], prev["tag"]) if b["para"] == prev["para"] else b["text"]
                       for b in st.beats[idx + 1:] if b["kind"] == "narration")
    between = (between + " " + before_text).strip()
    names = []
    for _, w in _alias_hits(between, st.aliases):
        if w not in names:
            names.append(w)
    if len(names) == 1:
        return names[0]
    if prev["who"] is not None and _talks_about(between, st.sex.get(prev["who"])):
        # the narration dwells on the previous speaker across several sentences
        # (library 204 -> 205): someone else takes the turn, but whom is the
        # owner's call -- a draft must not guess.
        return None
    return prev["who"]


def _drop_tag(narr, tag):
    """Narration after a line in its own paragraph opens with that line's remark
    (`said Bob. Alice smiled...`): the remark names the speaker, not the next one."""
    for k in range(len(tag)):
        head = tag[k:].strip()
        if head and narr.startswith(head):
            return narr[len(head):].strip()
    return narr


def _talks_about(narr, sex):
    """Narration opens several sentences with the previous speaker's pronoun:
    it is about them, so the reply is the other side's."""
    subj = [m.group(1).lower() for m in re.finditer(r"(?:^|[.!?]\s+)(He|She)\b", narr)]
    if len(subj) < 2:
        return False
    mine = "he" if sex == "man" else "she"
    return subj.count(mine) > len(subj) - subj.count(mine)


def _para_beats(st, n, p):
    spans = _quote_spans(p)
    if not spans:
        return [{"kind": "narration", "text": t, "para": n} for t in split_narration(p)]
    qs0, qe0 = spans[0]
    before = p[:qs0].strip()
    nxt = spans[1][0] if len(spans) > 1 else len(p)
    post_raw = p[qe0 + 1:nxt]
    m = SENT_END.search(post_raw)
    post = (post_raw[:m.end()] if m else post_raw).strip()
    pre = _pre_sentence(before)
    tag = (pre + " " + post).strip()
    if THOUGHT_RE.search(tag):
        return [{"kind": "narration", "text": p, "para": n}]
    inner = " ".join(p[a + 1:b].strip() for a, b in spans if p[a + 1:b].strip())
    decided, who = _from_tag(st, post, pre)
    if not decided:
        who = _by_position(st, n, before)
    out = []
    if _words(before) >= 4:
        out.append({"kind": "narration", "text": before, "para": n})
    out.append({"kind": "line", "who": who, "text": inner, "tag": tag, "para": n})
    rest, last = [], qe0 + 1
    for a, b in spans[1:]:
        rest.append(p[last:a])
        last = b + 1
    rest.append(p[last:])
    after = " ".join(" ".join(r.split()) for r in rest if r.strip())
    if _words(after) >= 4:
        out.append({"kind": "narration", "text": after, "para": n})
    return out


def parse_scene(text, scene, book):
    paras = split_paras(text)
    a, b = scene["paras"]
    if not (isinstance(a, int) and not isinstance(a, bool)
            and isinstance(b, int) and not isinstance(b, bool)
            and 0 <= a < b <= len(paras)):
        raise ValueError(f"scene {scene.get('id')} paras: {[a, b]} outside 0 <= from < to <= {len(paras)}")
    st = _State(scene, book)
    for n in range(a, b):
        p = " ".join(paras[n].split())
        for beat in _para_beats(st, n, p):
            st.beats.append(beat)
            if beat["kind"] == "line" and beat["who"]:
                st.hist.append(beat["who"])
    return st.beats


def warnings_for(beats):
    return [f"unattributed: {b['para']} {b['text'][:40]}"
            for b in beats if b["kind"] == "line" and b["who"] is None]


def score_scene(dir, scene_id, places=None, director=None):
    book = load_book(dir)
    ch, sc = find_scene(book, scene_id)
    with open(os.path.join(dir, ch["file"]), encoding="utf-8") as f:
        raw_text = f.read()
        beats = parse_scene(raw_text, sc, book)

    for i, b in enumerate(beats):
        b["id"] = i

    paras = split_paras(raw_text)[sc["paras"][0]:sc["paras"][1]]
    extra_warnings = []

    final_start, final_stage = run_staging(
        dir,
        paras,
        sc["cast"],
        places,
        sc,
        director,
        extra_warnings
    )

    for b in beats:
        bid = b["id"]
        if bid in final_stage and final_stage[bid]:
            b["stage"] = final_stage[bid]

    score = {
        "book": book.get("title", ""),
        "chapter": ch["n"],
        "scene": sc["id"],
        "place": sc.get("place", ""),
        "cast": list(sc["cast"]),
        "beats": beats,
        "warnings": warnings_for(beats) + extra_warnings
    }
    if final_start:
        score["start"] = final_start
    return score


def stats(score):
    kinds = Counter(b["kind"] for b in score["beats"])
    lines = [b for b in score["beats"] if b["kind"] == "line"]
    who = Counter(b["who"] or "null" for b in lines)
    share = (who.get("null", 0) / len(lines)) if lines else 0.0
    return {"kinds": dict(kinds), "who": dict(who), "unattributed_share": round(share, 3)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="book -> draft score")
    ap.add_argument("dir")
    ap.add_argument("--scene", required=True)
    ap.add_argument("--out")
    ap.add_argument("--stats", action="store_true")
    args = ap.parse_args(argv)
    score = score_scene(args.dir, args.scene)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(score, f, ensure_ascii=False, indent=2)
    if args.stats:
        print(json.dumps(stats(score), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
