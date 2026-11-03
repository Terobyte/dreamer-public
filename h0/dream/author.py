"""Wonder writes a whole opening scene (Oct 29, parked item of spec 7.3): hero soul,
actors with sides and arguments, events, objects, and a voice of their own for each.
The method is craft/scene_writing.md, distilled from the hand scene twelve_oaks;
the scene comes out in the same shape as scenes/*.json, so sim.py --scene plays it.
usage: python3 author.py "an idea in one line" [--source excerpt.txt] [--out path.json]
       cd h0/dream && python3 -m unittest -q test_author
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request

from fsm import _check_events, check_scene

try:
    from llm import call as llm_call
except ImportError:
    from .llm import call as llm_call

HERE = os.path.dirname(os.path.abspath(__file__))
CRAFT_PATH = os.path.join(HERE, "craft", "scene_writing.md")


def craft_file(craft=None):
    """The method file for a version: None -> the default scene_writing.md, "r2" ->
    scene_writing_r2.md (0.5: a new method lives beside the old one, never replaces
    it; the default stays what the A/B of Oct 29 kept)."""
    return "scene_writing.md" if not craft else "scene_writing_%s.md" % craft


def load_craft(craft=None):
    with open(os.path.join(HERE, "craft", craft_file(craft)), encoding="utf-8") as f:
        return f.read()


def craft_version(craft=None):
    return hashlib.sha1(load_craft(craft).encode("utf-8")).hexdigest()[:8]


CRAFT = load_craft()
# a run records which method wrote its scene, like dialogue.PROMPT_VERSION for lines
CRAFT_VERSION = craft_version()

VOICE_POOL = ("old_woman", "old_man", "woman", "man", "child", "creature")
_PERSON = ("\"name\", \"look\", \"voice\": {\"sound\": how they sound, \"search\": 2 or 3 "
           "short voice-library search words, \"fallback\": one of "
           + "|".join(VOICE_POOL) + "}")
AUTHOR_SCHEMA = (
    "Reply with JSON only: {\"question\": the one question of the scene, "
    "\"place\": one sentence, where and when, "
    "\"hero\": {" + _PERSON + ", \"soul\": {\"diary\", \"wants\": [2], \"fears\": [3], "
    "\"past_dream\", \"facts\": [{\"text\", \"hidden_from_hero\": true|false}]}}, "
    "\"situation_hero\": second person, "
    "\"actors\": 2 to 5 [{" + _PERSON + ", \"persona\": prose, third person}], "
    "\"events\": 3 to 5 [{\"t\": seconds 0-600, \"what\", \"who\": \"all\", "
    "\"kind\": \"world\"}], \"objects\": 5 to 8 names}.")
PICK_SCHEMA = ("Reply with JSON only: {person name: the id of the voice you pick}. "
               "Every person gets a different voice.")
ATTEMPTS = 2
CANDIDATES = 5
FISH_SEARCH = "https://api.fish.audio/model?"
_ID = re.compile(r"^[0-9a-f]{32}$")


def _json(text):
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[-1].rsplit("```", 1)[0]
    return json.loads(s)


def _strs(xs, n=None):
    ok = isinstance(xs, list) and all(isinstance(x, str) and x.strip() for x in xs)
    return ok and (n is None or len(xs) == n)


def check_authored(d):
    """The scene as Wonder wrote it -> reason or None. Same limits as a director's
    next_scene (fsm) plus the hero's soul, which a seeded scene never had."""
    if not isinstance(d, dict):
        return "json"
    for k in ("place", "situation_hero"):
        if not isinstance(d.get(k), str) or not d[k].strip():
            return k
    hero, actors = d.get("hero"), d.get("actors")
    if not isinstance(hero, dict) or not isinstance(actors, list) or len(actors) < 2:
        return "cast"
    people = [hero] + actors
    if not all(isinstance(p, dict) and isinstance(p.get("name"), str) and p["name"].strip()
               and isinstance(p.get("look"), str) and isinstance(p.get("voice"), dict)
               and p["voice"].get("fallback") in VOICE_POOL for p in people):
        return "person"
    names = [p["name"] for p in people]
    if len(set(names)) != len(names):
        return "names"
    if not all(isinstance(a.get("persona"), str) and a["persona"].strip() for a in actors):
        return "persona"
    soul = hero.get("soul")
    if not isinstance(soul, dict) or not isinstance(soul.get("diary"), str) \
            or not _strs(soul.get("wants")) or not _strs(soul.get("fears")) \
            or not isinstance(soul.get("past_dream"), str):
        return "soul"
    facts = soul.get("facts")
    if not isinstance(facts, list) or not facts or not all(
            isinstance(f, dict) and isinstance(f.get("text"), str)
            and isinstance(f.get("hidden_from_hero"), bool) for f in facts):
        return "facts"
    bad = check_scene({"objects": d.get("objects"),
                       "actors": [{"name": a["name"], "voice": a["voice"]["fallback"]} for a in actors]},
                      set(VOICE_POOL))
    if bad:
        return bad[1]
    return _check_events(d.get("events"), set(names), hero["name"])


def write_scene(text, source=None, transport=None, craft=None):
    """Up to ATTEMPTS asks for the scene, each checked -> Wonder's dict or None.
    `craft`: the method version (None = default, see craft_file)."""
    method = CRAFT if not craft else load_craft(craft)
    ask = "The idea of the dream:\n" + str(text or "").strip()
    if source:
        ask += "\n\nSource text, take everything from it:\n" + str(source).strip()
    for _ in range(ATTEMPTS):
        try:
            res = llm_call("director", method, [{"role": "user", "content":
                                                ask + "\n\n" + AUTHOR_SCHEMA}],
                           max_tokens=5000, _transport=transport)
            d = _json(res.text)
        except Exception:
            continue
        if check_authored(d) is None:
            return d
    return None


def fish_search(term, limit=CANDIDATES):
    """Public Fish voice library, searched by title; no key, no charge.
    -> [{id, title, about}] of English voices."""
    url = FISH_SEARCH + urllib.parse.urlencode(
        {"title": term, "page_size": 12, "sort_by": "score"})
    req = urllib.request.Request(url, headers={"User-Agent": "dream-author"})
    with urllib.request.urlopen(req, timeout=15) as r:
        items = json.load(r).get("items") or []
    out = []
    for m in items:
        if "en" in (m.get("languages") or []) and _ID.match(str(m.get("_id"))):
            out.append({"id": m["_id"], "title": m.get("title") or "",
                        "about": (m.get("description") or "")[:160]})
    return out[:limit]


def _terms(person):
    """The search words as a list: a model may send one string instead of a list."""
    s = person["voice"].get("search") or []
    return [s] if isinstance(s, (str, int, float)) else list(s)


def candidates(person, search):
    """Voices the library really has for one person: the look, not the memory."""
    seen, out = set(), []
    for term in _terms(person)[:3]:
        try:
            found = search(str(term))
        except Exception:
            continue
        for c in found:
            if c["id"] not in seen:
                seen.add(c["id"])
                out.append(c)
    return out[:CANDIDATES * 2]


def cast(d, search=fish_search, transport=None):
    """Up to ATTEMPTS Wonder calls pick a voice per person out of the library
    candidates. -> ({name: fish id}, note); a person with no valid pick keeps the
    pool fallback, and the note says why, so a failed casting is never silent."""
    people = [d["hero"]] + d["actors"]
    menu = {p["name"]: candidates(p, search) for p in people}
    if not any(menu.values()):
        return {}, "no_candidates"
    lines = []
    for p in people:
        lines.append("%s -- %s" % (p["name"], p["voice"].get("sound") or ""))
        for c in menu[p["name"]]:
            lines.append("  %s | %s | %s" % (c["id"], c["title"], c["about"]))
    note = "bad_reply"
    for _ in range(ATTEMPTS):
        try:
            res = llm_call("director", "You cast voices for a radio play.",
                           [{"role": "user", "content": "\n".join(lines) + "\n\n"
                             + PICK_SCHEMA}], max_tokens=600, _transport=transport)
            picks = _json(res.text)
        except Exception as e:
            note = "bad_reply: " + type(e).__name__
            continue
        if not isinstance(picks, dict):
            continue
        out, used = {}, set()
        for name, rid in picks.items():
            if name in menu and rid in {c["id"] for c in menu[name]} and rid not in used:
                out[name] = rid
                used.add(rid)
        if not out:
            note = "no_valid_pick"
            continue
        return out, ("ok" if len(out) == len(people) else "partial")
    return {}, note


def _label(name):
    return "cast_" + (re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "x")


def to_scene(d, picks, text, scene_id, cast_note=None, craft=None):
    """Wonder's dict -> the scenes/*.json shape; a picked voice goes in as a label
    of the scene's own voice_ids, so voice.py never gets a raw id from a reply."""
    voice_ids = {}

    def voice(p):
        rid = picks.get(p["name"])
        if not rid:
            return p["voice"]["fallback"]
        voice_ids[_label(p["name"])] = rid
        return _label(p["name"])

    h = d["hero"]
    scene = {
        "id": scene_id,
        "place": d["place"],
        "hero": {"name": h["name"], "voice": voice(h), "look": h["look"],
                 "soul": h["soul"]},
        "situation_hero": d["situation_hero"],
        "actors": [{"name": a["name"], "voice": voice(a), "look": a["look"],
                    "persona": a["persona"]} for a in d["actors"]],
        "events": d["events"],
        "objects": d["objects"],
    }
    scene["voice_ids"] = voice_ids
    scene["author"] = {"by": "wonder", "craft": craft_version(craft),
                       "craft_file": craft_file(craft), "idea": text,
                       "question": d.get("question"), "cast": cast_note,
                       "voices": {p["name"]: p["voice"] for p in [h] + d["actors"]}}
    return scene


def author_scene(text, source=None, transport=None, search=fish_search, scene_id="authored",
                 craft=None):
    """The whole step: scene, then casting -> a scene dict, or None when Wonder failed."""
    d = write_scene(text, source, transport, craft)
    if d is None:
        return None
    picks, note = cast(d, search, transport)
    return to_scene(d, picks, text, scene_id, note, craft)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("idea", help="the dream in one line")
    ap.add_argument("--source", default=None, help="a text file with the source excerpt")
    ap.add_argument("--out", default=None,
                    help="default h0/out/dream/scenes/<slug>.json")
    ap.add_argument("--craft", default=None,
                    help="method version: r2 = craft/scene_writing_r2.md (default: scene_writing.md)")
    args = ap.parse_args(argv)
    source = None
    if args.source:
        with open(args.source, encoding="utf-8") as f:
            source = f.read()
    slug = re.sub(r"[^a-z0-9]+", "_", args.idea.lower()).strip("_")[:40] or "scene"
    scene = author_scene(args.idea, source, scene_id=slug, craft=args.craft)
    if scene is None:
        print("author: wonder failed", file=sys.stderr)
        return 2
    out = args.out or os.path.join(HERE, "..", "out", "dream", "scenes", slug + ".json")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps(scene, indent=1, ensure_ascii=False) + "\n")
    print(os.path.abspath(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
