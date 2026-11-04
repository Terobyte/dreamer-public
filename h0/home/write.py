"""Create (a): the guest's idea -> a short chapter in one of our worlds, as a one-scene book make can stage.

One Spark contributor call writes {title, room, paragraphs}; the code checks it (room of the world, the
world's cast only, `"..." said Name.` lines, everyone speaks), retries once with the errors, then writes
<run>/book/{book.json, chapter.txt}. The chapter plays like our books: book mode first, freestyle after.
"""
import json
import re
from pathlib import Path

SCENE_ID = "custom"
MIN_PARAS, MAX_PARAS = 4, 14
LINE = re.compile(r'^"[^"]+"\s+said\s+(.+?)\.\s*$')
QUOTE = re.compile(r'"')

SYSTEM = """You write one short scene of a picture-book style story that a 3D engine will stage.
Answer with JSON only: {"title": str, "room": str, "paragraphs": [str, ...]}.
Rules:
- "room" is exactly one of the given room ids; the whole scene happens there.
- Only the given characters appear, every one of them speaks at least once. No other speaking people.
- 6 to 12 paragraphs. A paragraph is EITHER narration (one or two short sentences, no quotation marks)
  OR exactly one spoken line written as: "Words." said Name.   (straight double quotes, then said, the name, a full stop)
- Keep the book's tone and the characters' look and manner. Simple concrete actions the characters can do
  in that room (walk to, sit, look at, hug, point at a thing in the room).
- Follow the guest's idea; if it asks for violence, sex, real people or brands, keep the gentle spirit of the book instead.
"""


class ChapterError(ValueError):
    pass


def _book(world):
    return json.loads((Path(world["_book"]) / "book.json").read_text())


def rooms_of(world):
    scene = json.loads((Path(world["_dir"]) / "scene.json").read_text())
    return [str(r["id"]) for r in scene.get("rooms") or [] if isinstance(r, dict) and r.get("id")]


def _place_for(book, room):
    """the base book's place text for that room (scene room, else scene id), else the first scene's"""
    scenes = [sc for ch in book.get("chapters") or [] for sc in ch.get("scenes") or []]
    for sc in scenes:
        if (sc.get("room") or sc.get("id")) == room:
            return sc.get("place")
    return (scenes[0].get("place") if scenes else None) or room


def user_message(prompt, world):
    book = _book(world)
    who = world["who"]
    chars = "\n".join("- %s: %s" % (n, (book["cast"].get(n) or {}).get("look", "")) for n in who)
    return ("Book: %s by %s\nStyle: %s\nRooms: %s\nCharacters:\n%s\n\nThe guest's idea: %s"
            % (book.get("title"), book.get("author"), book.get("style") or "", ", ".join(rooms_of(world)), chars, prompt))


def check(ans, world):
    """-> list of errors (empty = good)"""
    errs = []
    if not isinstance(ans, dict):
        return ["answer is not a JSON object"]
    rooms = rooms_of(world)
    if ans.get("room") not in rooms:
        errs.append("room %r is not one of %s" % (ans.get("room"), rooms))
    if not isinstance(ans.get("title"), str) or not ans["title"].strip():
        errs.append("title is missing")
    paras = ans.get("paragraphs")
    if not isinstance(paras, list) or not all(isinstance(p, str) and p.strip() for p in paras):
        return errs + ["paragraphs must be a list of non-empty strings"]
    if not MIN_PARAS <= len(paras) <= MAX_PARAS:
        errs.append("%d paragraphs, need %d to %d" % (len(paras), MIN_PARAS, MAX_PARAS))
    spoke = set()
    for i, p in enumerate(paras):
        p = " ".join(p.split())
        if '"' not in p:
            continue
        m = LINE.match(p)
        if not m or len(QUOTE.findall(p)) != 2:
            errs.append('paragraph %d: a spoken line must be exactly "Words." said Name.' % i)
            continue
        name = m.group(1).strip()
        if name not in world["who"]:
            errs.append("paragraph %d: %r is not one of the characters %s" % (i, name, world["who"]))
        spoke.add(name)
    for n in world["who"]:
        if n not in spoke:
            errs.append("%s never speaks" % n)
    return errs


def _parse(text):
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-z]*\s*|\s*```$", "", t)
    try:
        return json.loads(t)
    except ValueError:
        m = re.search(r"\{.*\}", t, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except ValueError:
                pass
    return None


def fake_answer(world):
    who = world["who"]
    a, b = who[0], who[-1]
    return {"title": "A quiet visitor", "room": rooms_of(world)[0], "paragraphs": [
        "It was very quiet, and the light came in soft and slow.",
        '"Do you hear that?" said %s.' % a,
        "Something small was tapping at the window.",
        '"It is only the wind." said %s.' % b,
        "But the tapping came again, and they both went to look.",
        '"Then let us be brave together." said %s.' % a,
    ]}


def write_chapter(prompt, world, ask=None, fake=False):
    """-> the answer dict. ask(system, user) -> text (default: make.book.spark_call). ChapterError after 2 tries."""
    if fake:
        ans = fake_answer(world)
        errs = check(ans, world)
        if errs:
            raise ChapterError("; ".join(errs))
        return ans
    if ask is None:
        from make.book import spark_call as ask
    user = user_message(prompt, world)
    errs = []
    for _ in range(2):
        msg = user if not errs else user + "\n\nYour last answer was wrong: " + "; ".join(errs) + ". Answer again, JSON only."
        ans = _parse(ask(SYSTEM, msg))
        errs = check(ans, world)
        if not errs:
            ans["paragraphs"] = [" ".join(p.split()) for p in ans["paragraphs"]]
            return ans
    raise ChapterError("the chapter did not come out right: " + "; ".join(errs[:4]))


def write_book(ans, world, out: Path):
    """the answer -> out/book.json + out/chapter.txt (one chapter, one scene `custom`)"""
    base = _book(world)
    out.mkdir(parents=True, exist_ok=True)
    paras = ans["paragraphs"]
    (out / "chapter.txt").write_text("\n\n".join(paras) + "\n", encoding="utf-8")
    who = list(world["who"])
    pov = base.get("pov") if base.get("pov") in who else who[0]
    book = {
        "title": ans["title"].strip()[:80],
        "author": "a guest & Dreamer",
        "year": base.get("year"),
        "source": "written by Muse Spark from a guest's idea, in the world of %s" % base.get("title"),
        "pov": pov,
        "narrator_voice": base.get("narrator_voice") or "gentle",
        "style": base.get("style") or "",
        "cast": {n: base["cast"][n] for n in who},
        "chapters": [{"n": 1, "file": "chapter.txt", "title": ans["title"].strip()[:80], "scenes": [{
            "id": SCENE_ID, "paras": [0, len(paras)], "title": ans["title"].strip()[:80],
            "place": _place_for(base, ans["room"]), "cast": who,
            "aliases": {n: n for n in who}, "room": ans["room"]}]}],
    }
    (out / "book.json").write_text(json.dumps(book, ensure_ascii=False, indent=1), encoding="utf-8")
    return book
