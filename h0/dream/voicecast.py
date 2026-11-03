"""Voice casting by measuring, not by the cover (L177): character -> Fish voice.

Old way (author.cast, make.book pick_voice): an LLM picks from titles and descriptions, or a label by sex/age;
that is how an English scene got a Russian-accented narrator. New way:
  1. brief    one judge call per character: sex, age, accent, pitch, pace, texture, title search words
  2. pool     the project's own voices (voices.json: old_man, gentle ...) + Fish library search by title words
  3. ears     every candidate's free library sample measured (ears.py): sex, age, f0, pace, wer, ru/cy share
  4. gates    wrong sex, not English, mumbled (wer), Russian accent (p(ru)), age far off -> out, with the reason
  5. score    age, pitch band, pace, British-ness (cy share) when the brief asks for it, proven use count
  6. pick     one judge call over the measured facts; code makes every first choice a different voice
  7. listen   listen.html with the picks, players and the rejected; a person's choice is the gold set
usage:
  python3 voicecast.py --run <make run dir> [--book "A Study in Scarlet"]        measure + listen.html
  python3 voicecast.py --run <run dir> --apply [--choose Holmes=2,Narrator=old_man]   write the voices in
--apply puts each chosen voice into voices.json as <book>_<name> (a project voice keeps its own label),
the label into cast/cast.json and stage/stage.json narrator_voice; check_cast and stage read the pool as before.
"""
import argparse
import html
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

POOL_PATH = os.path.join(HERE, "voices.json")
HEARD_PATH = os.path.join(HERE, "voices_heard.json")   # {book slug: {name: label}} chosen by a person's ear, a re-cast keeps them
_ID = re.compile(r"^[0-9a-f]{32}$")
NARRATOR = "Narrator"

BRIEF = """You are a casting director for an audio drama. For the character below write a voice brief as JSON:
{"sex": "male|female|child", "age": <apparent age in years>, "accent": "e.g. British RP / Scottish / General American",
 "pitch": "low|mid|high", "pace": "slow|medium|fast", "texture": ["3-5 words: dry, raspy, warm, crisp, nasal..."],
 "search": ["8 Fish library search terms. Fish matches them as a SUBSTRING of the voice's TITLE (titles are short, like
            'British Narrator', 'Old Man', 'Deep British Male', 'Doctor'), so use 1-2 plain words that would appear in a title:
            'british', 'english man', 'narrator', 'gentleman', 'detective', 'doctor', 'storyteller'. Beware substrings:
            'victorian' also hits 'Victoria'. NO real people or celebrity names."],
 "why": "one sentence"}
Base it on the book's words, not on film actors. Reply with the JSON only."""

PICK = """You cast voices for an audio drama. Below, per character: the brief, then candidates that passed hard gates,
with MEASURED facts from their real audio (sex, age, f0 Hz, pace words/s, wer, brit = British-accent share) and the
library's tags and title. Trust measured facts over titles. Never pick a voice whose title names a real person,
celebrity or another franchise's character. Characters must sound different from each other (different f0 / texture).
Reply JSON {"<name>": ["id1","id2","id3"]} best first, ids only from that character's list."""

IP = """Below are voice titles from a public voice library, one per line as "<n>: <title> | <tags>".
Which of them name or imitate a real person (actor, celebrity, streamer, politician) or a character from an existing
film, show, anime, game or book franchise (e.g. "Gojo Satoru English Dub", "Squidward", "Morgan Freeman")?
Generic descriptions ("British Narrator", "Old Man", "Detective") are fine. Reply JSON {"flagged": [<n>, ...]}."""

PITCH = {"low": (60, 115), "mid": (95, 170), "high": (150, 320)}
YOUNG_PITCH = {"low": (140, 240), "mid": (180, 280), "high": (220, 340)}   # "low" for a boy of 14 is not a man's low
PACE = {"slow": 2.3, "medium": 2.7, "fast": 3.2}
SEARCH_TERMS = 8
PER_TERM = 12
LIMIT = 40
RU_SHARE = 0.15      # ru+uk share of the non-English mass: RU-accented 0.17-0.99, the rest <= 0.10 (n=60)
RU_FLOOR = 2e-4      # below this p(ru) the share is noise
NONEN_MAX = 0.05     # more than this is another language, not an accent
WER_MAX = 0.15
AGE_GAP = 22
YOUNG = 16          # below this age a male/female brief also takes a voice the ears hear as a child


def _json(text):
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[-1].rsplit("```", 1)[0]
    i, j = s.find("{"), s.rfind("}")
    return json.loads(s[i:j + 1] if i >= 0 and j > i else s)


def _llm(role, system, user, max_tokens=1500):
    from llm import call
    return call(role, system, [{"role": "user", "content": user}], max_tokens=max_tokens).text


def _search(term, n=PER_TERM):
    from author import fish_search
    return fish_search(term, n)


def _measure(vid):
    import ears
    return ears.measure(vid)


def load_pool(path=POOL_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def brief(person, book, call=_llm):
    """one judge call -> {sex, age, accent, pitch, pace, texture, search, why}; 3 tries"""
    ask = "Book: %s\nCharacter: %s\n%s\nWhat the book says: %s\nLines they speak: %s" % (
        book, person["name"], "This is the NARRATOR of the story." if person.get("narrator") else "",
        person.get("cues") or person.get("look") or "", " / ".join((person.get("lines") or [])[:5]))
    err = None
    for _ in range(3):
        try:
            d = _json(call("judge", BRIEF, ask))
            if isinstance(d, dict) and d.get("search") and d.get("sex"):
                if isinstance(d["search"], str):
                    d["search"] = [d["search"]]
                return d
        except Exception as e:
            err = e
    raise RuntimeError("no voice brief for %s: %s" % (person["name"], err))


def candidates(b, pool, search=_search, limit=LIMIT):
    """the project's own English voices first (they are proven), then the library by the brief's words"""
    seen, out = set(), []
    for label, rid in pool.items():
        if "@" not in label and _ID.match(str(rid)) and rid not in seen:
            seen.add(rid)
            out.append({"id": rid, "label": label})
    own = len(out)
    for term in b["search"][:SEARCH_TERMS]:
        try:
            found = search(str(term))
        except Exception:
            continue
        for c in found:
            if c["id"] not in seen:
                seen.add(c["id"])
                out.append({"id": c["id"]})
    return out[:own + limit]


def top_sex(r):
    return max(r["sex"], key=r["sex"].get)


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def gate(b, r):
    """hard gates on measured facts -> reason or None"""
    want = b.get("sex")
    young = _num(b.get("age")) is not None and _num(b.get("age")) < YOUNG   # a boy of 14 sounds like a child
    if want in ("male", "female") and top_sex(r) != want and not (young and top_sex(r) == "child"):
        return "sex %s" % top_sex(r)
    if "en" not in (r.get("langs") or []):
        return "langs %s" % r.get("langs")
    if r.get("wer") is None or r["wer"] > WER_MAX:
        return "wer %s" % r.get("wer")
    lp = r.get("lang_p") or {}
    if r.get("ru_share", 0) >= RU_SHARE and lp.get("ru", 0) + lp.get("uk", 0) >= RU_FLOOR:
        return "russian accent ru share %s" % r.get("ru_share")
    if r.get("p_nonen", 0) > NONEN_MAX:
        return "not english p=%s" % r.get("p_nonen")
    try:
        if want != "child" and not b.get("narrator") and abs(r["age"] - float(b["age"])) > AGE_GAP:
            return "age %s" % r["age"]
    except (TypeError, ValueError):
        pass
    return None


def _british(b):
    a = " %s " % str(b.get("accent", "")).lower()
    return "brit" in a or " rp " in a or "english" in a


def score(b, r):
    try:
        s = -abs(r["age"] - float(b["age"])) / 10
    except (TypeError, ValueError):
        s = 0.0
    young = _num(b.get("age")) is not None and _num(b.get("age")) < YOUNG
    lo, hi = (YOUNG_PITCH if young else PITCH).get(b.get("pitch"), (60, 340))
    if r.get("f0") and not lo <= r["f0"] <= hi:
        s -= min(abs(r["f0"] - lo), abs(r["f0"] - hi)) / 25
    s -= abs((r.get("pace_wps") or 2.7) - PACE.get(b.get("pace"), 2.7)) * 1.5
    if _british(b):
        cy = r.get("cy_share") or 0
        s += 2 * cy - (0.5 if cy < 0.1 else 0)     # British English leaks into Welsh
    s += math.log10(1 + (r.get("uses") or 0)) / 2  # many uses = proven in real TTS
    texture = {str(w).lower() for w in b.get("texture") or []}
    s += 0.5 * len({str(t).lower() for t in r.get("tags") or []} & texture)
    return round(s, 2)


def ip_flags(rows, call=_llm):
    """one judge call over all titles -> ids that name a real person or another franchise's character"""
    rows = list({r["id"]: r for r in rows}.values())
    if not rows:
        return set()
    ask = "\n".join("%d: %s | %s" % (k, (r.get("title") or "").replace("\n", " ")[:80],
                                       ",".join((r.get("tags") or [])[:6])) for k, r in enumerate(rows))
    for _ in range(3):
        try:
            d = _json(call("judge", IP, ask))
            return {rows[int(k)]["id"] for k in d.get("flagged") or [] if 0 <= int(k) < len(rows)}
        except Exception:
            continue
    raise RuntimeError("voicecast: the title check failed, no pick without it")


def distinct(res, taken=()):
    """every character's first choice its own voice, in cast order, none of the taken ones (voices already
    in the cast); the judge's order kept otherwise"""
    used = set(taken)
    for v in res.values():
        own = [i for i in v["pick"] + [r["id"] for r in v["ok"]] if i not in used]
        if own:
            v["pick"] = [own[0]] + [i for i in v["pick"] if i != own[0]][:2]
            used.add(own[0])
    return res


def _facts_line(r):
    return "  %s | %s | tags %s | %s age %s f0 %s pace %s wer %s brit %s | score %s" % (
        r["id"], r.get("label") or r.get("title"), ",".join((r.get("tags") or [])[:8]), top_sex(r), r["age"],
        r["f0"], r["pace_wps"], r["wer"], r.get("cy_share"), r["score"])


def cast_voices(people, book, call=_llm, search=_search, measure=_measure, pool=None, log=print, taken=()):
    """people: [{name, look|cues, lines?, narrator?}] -> {name: {brief, rows, ok, pick}}"""
    pool = load_pool() if pool is None else pool
    res = {}
    for p in people:
        b = brief(p, book, call)
        if p.get("narrator"):
            b["narrator"] = True     # a storyteller's age is a taste, not a gate (old_man tells Squid's story)
        rows = []
        for c in candidates(b, pool, search):
            try:
                r = dict(measure(c["id"]))
            except Exception as e:
                log("ears: skip %s %s" % (c["id"], type(e).__name__))
                continue
            if c.get("label"):
                r["label"] = c["label"]
            r["gate"] = gate(b, r)
            r["score"] = None if r["gate"] else score(b, r)
            rows.append(r)
        res[p["name"]] = {"brief": b, "rows": rows, "ok": [], "pick": []}
    flagged = ip_flags([r for v in res.values() for r in v["rows"] if not r["gate"]], call)
    for n, v in res.items():
        for r in v["rows"]:
            if r["id"] in flagged and not r["gate"]:
                r["gate"], r["score"] = "names a real person or a franchise character", None
        v["ok"] = sorted([r for r in v["rows"] if not r["gate"]], key=lambda r: -r["score"])[:8]
        log("voicecast: %s %d candidates, %d pass" % (n, len(v["rows"]), len(v["ok"])))
    lines = []
    for n, v in res.items():
        lines.append("## %s -- brief %s" % (n, json.dumps(v["brief"], ensure_ascii=False)))
        lines += [_facts_line(r) for r in v["ok"]]
    picks = {}
    for _ in range(3):
        try:
            picks = _json(call("judge", PICK, "\n".join(lines)))
            if isinstance(picks, dict):
                break
        except Exception:
            picks = {}
    for n, v in res.items():
        ids = {r["id"] for r in v["ok"]}
        got = picks.get(n) if isinstance(picks.get(n), list) else []
        v["pick"] = [i for i in got if i in ids][:3] or [r["id"] for r in v["ok"][:3]]
    return distinct(res, taken)


def page(res, out_html, cache=None):
    """listen.html: per character the picks first, then alternatives, players on the cached samples"""
    if cache is None:
        import ears
        cache = ears.CACHE
    h = ["<!DOCTYPE html><meta charset=utf-8><title>voice cast</title><style>body{font:14px system-ui;max-width:1100px;"
         "margin:2em auto}td{padding:4px 8px;border-bottom:1px solid #ddd;vertical-align:top}.g{color:#999}</style>"]
    for n, v in res.items():
        h.append("<h2>%s</h2><p><b>brief:</b> %s</p><table>" % (
            html.escape(n), html.escape(json.dumps(v["brief"], ensure_ascii=False))))
        byid = {r["id"]: r for r in v["rows"]}
        order = v["pick"] + [r["id"] for r in v["ok"] if r["id"] not in v["pick"]][:2]
        for k, i in enumerate(order):
            r = byid[i]
            mp3 = os.path.abspath(os.path.join(cache, i + ".mp3"))
            tag = "PICK %d" % (k + 1) if i in v["pick"] else "alt %d" % (k + 1)
            own = " (project voice <b>%s</b>)" % html.escape(r["label"]) if r.get("label") else ""
            h.append("<tr><td>%s</td><td><b>%s</b>%s<br><code>%s</code><br>%s</td><td><audio controls preload=none "
                     "src='file://%s'></audio></td><td>%s, ~%s y, f0 %s Hz, %s w/s, wer %s, ru %s, brit %s<br>"
                     "uses %s, score %s</td></tr>" % (
                         tag, html.escape(r.get("title") or ""), own, i, html.escape(", ".join((r.get("tags") or [])[:8])),
                         html.escape(mp3), top_sex(r), r["age"], r["f0"], r["pace_wps"], r["wer"], r.get("ru_share"),
                         r.get("cy_share"), r.get("uses"), r["score"]))
        rej = [r for r in v["rows"] if r["gate"]]
        h.append("</table><p class=g>rejected by ears: %s</p>" % html.escape(
            "; ".join("%s (%s)" % ((r.get("label") or r.get("title") or "")[:30], r["gate"]) for r in rej)))
    with open(out_html, "w", encoding="utf-8") as f:
        f.write("\n".join(h))


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_") or "x"


def choose(res, choice=None):
    """{name: fish id}: the first pick, or the user's choice: a 1-based row of listen.html, a fish id or a pool label"""
    choice = choice or {}
    pool = load_pool()
    out = {}
    for n, v in res.items():
        c = str(choice.get(n, "1"))
        order = v["pick"] + [r["id"] for r in v["ok"] if r["id"] not in v["pick"]][:2]
        if c.isdigit() and 1 <= int(c) <= len(order):
            out[n] = order[int(c) - 1]
        elif _ID.match(c):
            out[n] = c
        elif c in pool:
            out[n] = pool[c]
        else:
            raise ValueError("%s: no choice %r" % (n, c))
    return out


PREFIX = "vc_"   # pool labels voicecast owns: re-cast overwrites them, make.book leaves them out of its step hash


def add_to_pool(book, chosen, pool_path=POOL_PATH):
    """{name: fish id} -> {name: pool label}; a voice the pool already has keeps its label,
    a new one becomes vc_<book>_<name> (overwritten on a re-cast of the same book)"""
    with open(pool_path, encoding="utf-8") as f:
        pool = json.load(f)
    by_id = {rid: label for label, rid in pool.items() if "@" not in label and not label.startswith(PREFIX)}
    labels = {}
    for name, rid in chosen.items():
        label = by_id.get(rid) or "%s%s_%s" % (PREFIX, _slug(book)[:24], _slug(name))
        if label.startswith(PREFIX):
            pool[label] = rid
        labels[name] = label
    with open(pool_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(pool, indent=2, ensure_ascii=False) + "\n")
    return labels


def heard(book, path=HEARD_PATH):
    """{name: pool label} a person chose by ear for this book; make.book's live cast does not re-cast them"""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return dict(json.load(f).get(_slug(book)) or {})


def hear(book, labels, path=HEARD_PATH):
    d = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    d.setdefault(_slug(book), {}).update(labels)
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(d, indent=1, ensure_ascii=False, sort_keys=True) + "\n")


def apply(run_dir, book, chosen, pool_path=POOL_PATH, heard_path=HEARD_PATH):
    """a person's choice: pool labels, cast.json voice, stage.json narrator_voice, voices_heard.json -> {name: label}"""
    labels = add_to_pool(book, chosen, pool_path)
    hear(book, labels, heard_path)
    cast_p = os.path.join(run_dir, "cast", "cast.json")
    with open(cast_p, encoding="utf-8") as f:
        cast = json.load(f)
    for name, c in cast.items():
        if name in labels:
            c["voice"] = labels[name]
    with open(cast_p, "w", encoding="utf-8") as f:
        f.write(json.dumps(cast, indent=1, ensure_ascii=False) + "\n")
    stage_p = os.path.join(run_dir, "stage", "stage.json")
    if NARRATOR in labels and os.path.exists(stage_p):
        with open(stage_p, encoding="utf-8") as f:
            st = json.load(f)
        st["narrator_voice"] = labels[NARRATOR]
        with open(stage_p, "w", encoding="utf-8") as f:
            f.write(json.dumps(st, indent=2, ensure_ascii=False) + "\n")
    return labels


def people_of(run_dir):
    """cast.json of a make run -> people for cast_voices, the narrator last"""
    with open(os.path.join(run_dir, "cast", "cast.json"), encoding="utf-8") as f:
        cast = json.load(f)
    out = [{"name": n, "look": "%s; %s" % (c.get("sex") or "", c.get("look") or ""), "lines": c.get("lines") or []}
           for n, c in cast.items() if isinstance(c, dict)]
    return out + [{"name": NARRATOR, "narrator": True, "look": "who tells the story"}]


def _book_title(run_dir):
    p = os.path.join(run_dir, "stage", "stage.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            b = json.load(f).get("book")
        if isinstance(b, dict) and b.get("dir"):
            return os.path.basename(os.path.normpath(b["dir"]))
    return os.path.basename(os.path.normpath(run_dir))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--run", required=True, help="a make run dir with cast/cast.json (stage/stage.json optional)")
    ap.add_argument("--book", default=None, help="book title for the briefs (default: from stage.json)")
    ap.add_argument("--apply", action="store_true", help="write the chosen voices into pool, cast and stage")
    ap.add_argument("--choose", default="", help="Name=N|fish id|pool label, comma separated (default: PICK 1)")
    a = ap.parse_args(argv)
    run = os.path.abspath(a.run)
    book = a.book or _book_title(run)
    out = os.path.join(run, "cast", "voicecast.json")
    if a.apply and os.path.exists(out):
        with open(out, encoding="utf-8") as f:
            res = json.load(f)
    else:
        res = cast_voices(people_of(run), book)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1, ensure_ascii=False)
        page(res, os.path.join(run, "cast", "listen.html"))
        print(os.path.join(run, "cast", "listen.html"))
    for n, v in res.items():
        print("PICK", n, v["pick"])
    if a.apply:
        ch = dict(kv.split("=", 1) for kv in a.choose.split(",") if "=" in kv)
        print("applied", apply(run, book, choose(res, ch)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
