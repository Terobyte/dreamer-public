"""A voice the library does not have: design it in words, measure it, clone it into Fish (L177).

voicecast finds library voices; when none passes the ears for a character (no British boy of 14 for John Reed),
this module makes one:
  1. instructs  one judge call: 3 different VoiceDesign descriptions + a line in the character's manner
  2. design     Qwen3-TTS VoiceDesign on Modal (voice_design_modal.py), 3 x SEEDS wavs, the seed matters a lot
  3. ears       ears.measure_wav + voicecast gate/score with the character's brief, the same as library voices
  4. clone      the best wav -> a private Fish model (POST /model), cached by the wav's hash: no twin models
  5. listen     design.html in the step dir; a person re-chooses with --pick, that choice is kept (voices_heard)
The ears are weak on children (an unbroken boy is "female 0.97"): the automatic pick is a fallback, the ear decides.
usage:
  python3 voicedesign.py --dir <voices step dir> --book "Jane Eyre" --name "John Reed" --design   9 voices, no clone
  python3 voicedesign.py --dir <voices step dir> --book "Jane Eyre" --name "John Reed" --pick 6   clone, pool, taste
"""
import argparse
import concurrent.futures
import hashlib
import html
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import voicecast as vc  # noqa: E402

CLONES_PATH = os.path.join(HERE, "..", "out", "dream", "clones.json")   # {sha1 of wav: fish id}
TASTE_PATH = os.path.join(HERE, "voices_taste.json")   # the user's ear: designs picked and passed over, newest last
TASTE_SHOWN = 4
SEEDS = 3
FISH_MODEL = "https://api.fish.audio/model"

INSTRUCT = """You write voice descriptions for a text-to-speech model that DESIGNS a new voice from words.
Character below, with a casting brief. Reply JSON:
{"instructs": [3 descriptions, each 25-60 words, each a different take on the same character],
 "sample": "a line of 15-40 words this character could say, in their manner, in STANDARD English spelling (the
            accent is in the voice, not the spelling: whisper checks the words)"}
Rules that worked (and failures to avoid):
- Begin with the sex and age in plain words: "Male. A fourteen-year-old English boy..." The model drifts to a
  woman when it is not said first.
- A boy under 16: a teenage boy's voice, it may waver between high and low; do not make him a grown man.
- Name the accent precisely: "posh southern English, British Received Pronunciation", "General American".
- Then texture, pitch, pace and manner: "thick, slightly nasal, lazy drawl, sulky and cruel, talking down to..."
- No real people, actors or celebrities; no film or franchise characters."""


def line_of(person, sample="", accent=None):
    """the character's own line of 15-45 words if it has one, else the judge's sample; with an accent the ears
    cannot hear, always the sample: Wee Jamie's "gonnae no dae that" read perfectly is wer 0.5 to whisper"""
    if accent and sample:
        return sample
    lines = [str(s).strip() for s in person.get("lines") or [] if str(s).strip()]
    fit = [s for s in lines if 15 <= len(s.split()) <= 45]
    if fit:
        return max(fit, key=lambda s: len(s.split()))
    return sample or (max(lines, key=len) if lines else "")


def taste(path=None):
    path = path or TASTE_PATH
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def remember(entry, path=None):
    """a choice by ear: {book, name, brief, picked: instruct, passed_over: [instructs], facts}"""
    path = path or TASTE_PATH
    t = taste(path) + [entry]
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(t, indent=1, ensure_ascii=False) + "\n")


def _taste_lines(path=None):
    out = []
    for e in taste(path)[-TASTE_SHOWN:]:
        f = e.get("facts") or {}
        out.append("- %s (%s, age %s): LIKED %r -> it came out at f0 %s Hz, British share %s" % (
            e["name"], e["brief"].get("sex"), e["brief"].get("age"), e["picked"], f.get("f0"), f.get("cy_share")))
        out += ["  passed over: %r" % s for s in (e.get("passed_over") or [])[:2]]
    return out


def instructs(person, b, book, call=vc._llm, taste_path=None):
    ask = "Book: %s\nCharacter: %s\nWhat the book says: %s\nLines: %s\nBrief: %s" % (
        book, person["name"], person.get("look") or person.get("cues") or "",
        " / ".join((person.get("lines") or [])[:5]), json.dumps(b, ensure_ascii=False))
    liked = _taste_lines(taste_path)
    if liked:
        ask += ("\nThe user's ear on earlier designs. Aim for how the liked ones CAME OUT (f0, accent), not for "
                "stronger versions of their words: after 'low-pitched for his age' was liked, 'low, thick, heavy' "
                "gave 8 grown men of 9 (f0 95-111).\n" + "\n".join(liked))
    for _ in range(3):
        try:
            d = vc._json(call("judge", INSTRUCT, ask))
            ins = [s for s in (d.get("instructs") or []) if isinstance(s, str) and s.strip()]
            if ins:
                return ins[:3], str(d.get("sample") or "")
        except Exception:
            continue
    raise RuntimeError("no voice descriptions for " + person["name"])


def modal_generate(spec, out_dir):
    """voice_design_modal.py on Modal -> wav paths"""
    os.makedirs(out_dir, exist_ok=True)
    sp = os.path.join(out_dir, "spec.json")
    with open(sp, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)
    subprocess.run(["modal", "run", os.path.join(HERE, "voice_design_modal.py"), "--spec", sp, "--out", out_dir],
                   check=True, capture_output=True, timeout=1800, stdin=subprocess.DEVNULL)
    return sorted(os.path.join(out_dir, f) for f in os.listdir(out_dir) if re.fullmatch(r"d\d+_s\d+\.wav", f))


def _measure_wav(path, text):
    import ears
    return ears.measure_wav(path, text, title="design " + os.path.basename(path))


def design_voice(person, b, book, out_dir, call=vc._llm, generate=modal_generate, measure=_measure_wav,
                 seeds=SEEDS):
    """-> {brief, text, instructs, rows, ok, pick, dir}; pick = the best wav's name or None"""
    ins, sample = instructs(person, b, book, call)
    text = line_of(person, sample, accent_word(b))
    if not text:
        raise RuntimeError("no line to design %s with" % person["name"])
    rows = []
    for p in generate({"name": person["name"], "text": text, "instructs": ins, "seeds": seeds}, out_dir):
        r = dict(measure(p, text))
        r["id"], r["instruct"] = os.path.basename(p), ins[int(re.match(r"d(\d+)", os.path.basename(p)).group(1))]
        r["gate"] = vc.gate(b, r)
        r["score"] = None if r["gate"] else vc.score(b, r)
        rows.append(r)
    ok = sorted([r for r in rows if not r["gate"]], key=lambda r: -r["score"])
    return {"brief": b, "text": text, "instructs": ins, "rows": rows, "ok": [r["id"] for r in ok],
            "pick": ok[0]["id"] if ok else None, "dir": os.path.abspath(out_dir)}


def _sha1(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


def _load(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def fish_clone(wav, title, text):
    """a private Fish voice from one wav -> its id (an outward call: a model on the account, private)"""
    import requests
    sys.path.insert(0, os.path.join(HERE, ".."))
    import keys
    with open(wav, "rb") as f:
        r = requests.post(FISH_MODEL, headers={"Authorization": "Bearer " + keys.get("FISH")}, timeout=180,
                          data={"type": "tts", "train_mode": "fast", "title": title[:60], "visibility": "private",
                                "texts": text},
                          files={"voices": (os.path.basename(wav), f, "audio/wav")})
    r.raise_for_status()
    return r.json()["_id"]


def clone(wav, title, text, make=fish_clone, path=CLONES_PATH, facts=None, ears_cache=None):
    """the same wav is cloned once: a rerun gets the same Fish id. `facts` (the design's row) go to the ears'
    cache under the clone's id: the ears cannot fetch a private model, a re-cast would drop it"""
    key = _sha1(wav)
    known = _load(path)
    rid = known.get(key) or make(wav, title, text)
    if key not in known:
        known[key] = rid
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(known, f, indent=1)
    if facts:
        import ears
        cache = ears_cache or ears.CACHE
        r = {k: v for k, v in facts.items() if k not in ("gate", "score", "instruct", "seed")}
        r.update(v=ears.VERSION, id=rid, title=title)
        os.makedirs(cache, exist_ok=True)
        with open(os.path.join(cache, rid + ".ears.json"), "w", encoding="utf-8") as f:
            json.dump(r, f, indent=1)
    return rid


PLAIN = {"british", "english", "rp", "received", "pronunciation", "american", "general", "neutral", "standard",
         "southern", "posh", "upper", "class", "accent", "us", "uk", "mid", "atlantic", "light", "slight", "with", "a"}


def accent_word(b):
    """the brief's accent when the ears cannot measure it (they hear only Russian and British): "scottish"..."""
    for w in re.findall(r"[a-z]+", str(b.get("accent") or "").lower()):
        if w not in PLAIN:
            return w
    return None


def weak(b, v):
    """the library passed someone, but a pass is not a fit: a child (no sex gate, generic "Child" voices) or an
    accent the ears cannot hear that no passed title names (Wee Jamie, Glaswegian, got "Energetic Child")"""
    young = b.get("sex") == "child" or (vc._num(b.get("age")) is not None and vc._num(b["age"]) < vc.YOUNG)
    acc = accent_word(b)
    named = acc and any(acc[:5] in (r.get("title") or "").lower() for r in v.get("ok") or [] if isinstance(r, dict))
    return bool(young or (acc and not named))


def winner(b, v, dv):
    """design or library for a weak match -> (side, why); the same score, without the library's use count
    and tags a design cannot have; an accent only the design was asked for goes to the design"""
    lib = [r for r in v.get("ok") or [] if isinstance(r, dict)]
    best = {r["id"]: r for r in dv["rows"]}.get(dv.get("pick"))
    if not best:
        return "library", "no design passed the ears"
    if not lib:
        return "design", "no library voice passed"
    acc = accent_word(b)
    top = max(lib, key=lambda r: vc.score(b, dict(r, uses=0, tags=[])))
    if acc and acc[:5] not in (top.get("title") or "").lower():
        # the accent counts for the voice that would win, not any passed one ("Scottish soilder" for Wee Jamie)
        return "design", "%s accent: only the design was asked for it" % acc
    ls = vc.score(b, dict(top, uses=0, tags=[]))
    ds = vc.score(b, best)
    return ("design" if ds >= ls else "library"), "design %s vs library %s" % (ds, ls)


def design_missing(people, res, book, step_dir, call=vc._llm, generate=modal_generate, measure=_measure_wav,
                   make=fish_clone, log=print, clones=CLONES_PATH, clone_best=True):
    """characters voicecast left without a voice, or with a weak match (weak) -> designed, measured; the best
    design is cloned (clone_best) when it beats the library (winner). Adds to design.json + design.html in
    step_dir; -> {name: fish id} of the designs that won"""
    need = [p for p in people if p["name"] in res and (not res[p["name"]].get("pick") or
                                                         weak(res[p["name"]]["brief"], res[p["name"]]))]
    if not need:
        return {}
    out = {}

    def one(p):
        d = os.path.join(step_dir, "design", vc._slug(p["name"]))
        return p, design_voice(p, res[p["name"]]["brief"], book, d, call, generate, measure)

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(need))) as ex:
        for fut in [ex.submit(one, p) for p in need]:
            try:
                p, dv = fut.result()
            except Exception as e:
                log("voicedesign: %s" % (e,))
                continue
            v = res[p["name"]]
            dv["won"], dv["why"] = winner(v["brief"], v, dv) if v.get("pick") else (
                ("design", "no library voice passed") if dv["pick"] else ("library", "no design passed the ears"))
            out[p["name"]] = dv
            log("voicedesign: %s %d designs, %d pass, %s wins (%s)" % (
                p["name"], len(dv["rows"]), len(dv["ok"]), dv["won"], dv["why"]))
    if not out:
        return {}
    allv = dict(_load(os.path.join(step_dir, "design.json")), **out)   # a redesign of one keeps the others
    with open(os.path.join(step_dir, "design.json"), "w", encoding="utf-8") as f:
        json.dump(allv, f, ensure_ascii=False, indent=1)
    page(allv, os.path.join(step_dir, "design.html"))
    ids = {}
    for name, dv in out.items():
        if dv["pick"] and clone_best and dv["won"] == "design":
            row = {r["id"]: r for r in dv["rows"]}[dv["pick"]]
            ids[name] = clone(os.path.join(dv["dir"], dv["pick"]), "%s (%s)" % (name, book), dv["text"], make, clones,
                              facts=row)
    return ids


def order(dv):
    """listen order: passed designs best first, then the rejected; --pick N counts in this order"""
    return dv["ok"] + [r["id"] for r in dv["rows"] if r["id"] not in dv["ok"]]


def page(out, out_html):
    h = ["<!DOCTYPE html><meta charset=utf-8><title>designed voices</title><style>body{font:14px system-ui;"
         "max-width:1000px;margin:2em auto}td{padding:4px 8px;border-bottom:1px solid #ddd}.g{color:#999}</style>"]
    base = os.path.dirname(os.path.abspath(out_html))
    for name, dv in out.items():
        byid = {r["id"]: r for r in dv["rows"]}
        h.append("<h2>%s</h2><p>%s</p><table>" % (html.escape(name), html.escape(dv["text"])))
        for n, i in enumerate(order(dv), 1):
            r = byid[i]
            src = os.path.relpath(os.path.join(dv["dir"], i), base)
            h.append("<tr class='%s'><td>%d%s</td><td><audio controls preload=none src='%s'></audio><br><small>%s</small>"
                     "</td><td>%s ~%s y, f0 %s, %s w/s, wer %s, brit %s<br>%s</td></tr>" % (
                         "g" if r["gate"] else "", n, " PICK" if i == dv["pick"] else "", html.escape(src),
                         html.escape(r["instruct"][:120]), vc.top_sex(r), r["age"], r["f0"], r["pace_wps"], r["wer"],
                         r["cy_share"], html.escape(r["gate"] or "score %s" % r["score"])))
        h.append("</table>")
    with open(out_html, "w", encoding="utf-8") as f:
        f.write("\n".join(h))


def pick(step_dir, name, n, book, make=fish_clone, clones=CLONES_PATH, pool_path=vc.POOL_PATH,
         heard_path=vc.HEARD_PATH, taste_path=None):
    """a person's ear: design N of design.html -> clone -> pool label, kept on every re-cast"""
    dv = _load(os.path.join(step_dir, "design.json"))[name]
    wav = os.path.join(dv["dir"], order(dv)[int(n) - 1])
    chosen = {r["id"]: r for r in dv["rows"]}[os.path.basename(wav)]
    rid = clone(wav, "%s (%s)" % (name, book), dv["text"], make, clones, facts=chosen)
    labels = vc.add_to_pool(book, {name: rid}, pool_path)
    vc.hear(book, labels, heard_path)
    remember({"book": book, "name": name, "brief": dv["brief"], "picked": chosen["instruct"],
              "passed_over": sorted({r["instruct"] for r in dv["rows"]} - {chosen["instruct"]}),
              "facts": {k: chosen.get(k) for k in ("sex", "age", "f0", "pace_wps", "cy_share", "gate")}}, taste_path)
    return labels


def redesign(step_dir, names, book, **kw):
    """the ear said "не то" to a library voice that passed: design these names from a make.book voices step
    (book.json for look and lines, voicecast.json for the brief); nothing is cloned until --pick"""
    cast = _load(os.path.join(step_dir, "book.json")).get("cast") or {}
    briefs = _load(os.path.join(step_dir, "voicecast.json"))
    people, res = [], {}
    for n in names:
        if n not in cast or n not in briefs:
            raise ValueError("%s: not in book.json cast and voicecast.json" % n)
        c = cast[n]
        people.append({"name": n, "look": "%s, about %s; %s" % (c.get("sex") or "", c.get("age") or "?",
                                                                c.get("look") or ""), "lines": c.get("lines") or []})
        res[n] = {"brief": briefs[n]["brief"], "pick": []}
    kw.setdefault("clone_best", False)
    return design_missing(people, res, book, step_dir, **kw)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", required=True, help="the make.book voices step dir")
    ap.add_argument("--name", required=True, action="append", help="character; --design takes several")
    ap.add_argument("--design", action="store_true", help="design voices for --name -> design.html, no clone")
    ap.add_argument("--pick", help="row number in design.html: clone it, put it in the pool, remember the taste")
    ap.add_argument("--book", required=True, help="book title, as make.book used it")
    a = ap.parse_args(argv)
    d = os.path.abspath(a.dir)
    if a.design:
        redesign(d, a.name, a.book)
        print(os.path.join(d, "design.html"))
    if a.pick:
        print("picked", pick(d, a.name[0], a.pick, a.book))
    if not (a.design or a.pick):
        ap.error("--design or --pick")
    return 0


if __name__ == "__main__":
    sys.exit(main())
