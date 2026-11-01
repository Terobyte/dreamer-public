"""Stage `stage`: world/run/ (+ cast, story) -> stage/places.json + stage/stage.json.

Places come from the built world, not from the author's guesses: position and yaw from
dist/geometry.json, size from scene.json, doors from dist/build.json, walkability from nav.json.
Yaw convention as engine/src/nav/floor.ts: 0 deg = +Z, 90 deg = +X.
"""
import base64
import json
import math
import re
import time
from pathlib import Path

SIT = {"sofa", "couch", "chair", "armchair", "bench", "bed", "stool", "seat"}
SNAP_R = 1.0
LIE_SIT = {"bed", "sofa", "couch"}
SIT_ONLY = {"chair", "bench", "armchair"}
STOOLS = {"stool", "step"}
STAND_ON_MAX_H = 0.6


def _load(p):
    return json.loads(Path(p).read_text())


def _front(yaw):
    r = math.radians(yaw)
    return math.sin(r), math.cos(r)


def _base_id(mid):
    return re.sub(r"\.\d+$", "", mid)


def _last_word(pid):
    return _base_id(pid).split("_")[-1]


class _Nav:
    def __init__(self, nav):
        layers = nav.get("layers") or []
        self.layers = {}
        for L in layers:
            if L.get("bits"):
                self.layers[L["level"]] = (L, base64.b64decode(L["bits"]))
        self.cell = nav.get("cell", 0.04)
        self.first = layers[0]["level"] if layers else None

    def _ok(self, L, bits, i, j):
        if i < 0 or j < 0 or i >= L["w"] or j >= L["h"]:
            return False
        n = j * L["w"] + i
        return bool((bits[n >> 3] >> (n & 7)) & 1)

    def snap(self, level, x, z):
        """x, z itself when its cell is walkable, else the centre of the nearest walkable cell
        within SNAP_R on the same level; None when there is none (or no nav at all)."""
        L, bits = self.layers.get(level, (None, None))
        if L is None:
            return None
        c = self.cell
        # plain floor, no epsilon: a point even slightly outside the grid must
        # miss its cell (F4/F10) and fall through to the centre search below,
        # never echo back as walkable.
        i0 = math.floor((x - L["origin"][0]) / c)
        j0 = math.floor((z - L["origin"][1]) / c)
        if self._ok(L, bits, i0, j0):
            return [x, z]
        r = int(math.ceil(SNAP_R / c)) + 1
        best = None
        for dj in range(-r, r + 1):
            for di in range(-r, r + 1):
                i, j = i0 + di, j0 + dj
                if not self._ok(L, bits, i, j):
                    continue
                cx = L["origin"][0] + (i + 0.5) * c
                cz = L["origin"][1] + (j + 0.5) * c
                d = math.hypot(cx - x, cz - z)
                if d <= SNAP_R and (best is None or d < best[0]):
                    best = (d, cx, cz)
        if best is None:
            return None
        return [best[1], best[2]]


def _poses(word, h):
    """the one word -> poses table (last word of the prop id)."""
    if word in LIE_SIT:
        return ["lie", "sit"]
    if word in SIT_ONLY:
        return ["sit"]
    if word in STOOLS:
        return ["stand_on", "sit"] if h <= STAND_ON_MAX_H else ["sit"]
    return ["stand_at"]


def _centre(m):
    if m.get("glbPos"):
        return m["glbPos"][0], m["glbPos"][2]
    p = m.get("positions") or []
    xs, zs = p[0::3], p[2::3]
    return (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2


def _obstacle(cx, cz, w, d, yaw):
    r = math.radians(yaw)
    ex = abs(w / 2 * math.cos(r)) + abs(d / 2 * math.sin(r))
    ez = abs(w / 2 * math.sin(r)) + abs(d / 2 * math.cos(r))
    return [cx - ex, cz - ez, cx + ex, cz + ez]


def _name_places(items):
    """last word of the id; a repeat anywhere in the scene gets the room, a repeat after that ` 2`, ` 3`."""
    cnt = {}
    for it in items:
        cnt[it["base"]] = cnt.get(it["base"], 0) + 1
    seen = {}
    for it in items:
        n = f"{it['room']} {it['base']}" if cnt[it["base"]] > 1 else it["base"]
        seen[n] = seen.get(n, 0) + 1
        it["name"] = n if seen[n] == 1 else f"{n} {seen[n]}"


def build_places(world_run):
    """-> {"places": [...], "warnings": [...]}; world_run = folder with scene.json and dist/."""
    wr = Path(world_run)
    scene = _load(wr / "scene.json")
    geo = _load(wr / "dist" / "geometry.json")
    nav = _Nav(_load(wr / "dist" / "nav.json"))
    build = _load(wr / "dist" / "build.json") if (wr / "dist" / "build.json").is_file() else {}
    props = {p["id"]: p for p in scene.get("props", [])}
    rooms = {r["id"]: r for r in scene.get("rooms", [])}
    warnings, items = [], []
    for m in geo.get("meshes", []):
        if m.get("kind") != "prop":
            continue
        pid = _base_id(m["id"])
        sc = props.get(pid)
        if sc is None:
            warnings.append(f"{m['id']}: no prop in scene.json, skipped")
            continue
        # rug/cushion (solid false), lamp on a table, picture on a wall: no place.
        # mount "floor" is the engine default for a free-standing prop, not an attachment.
        mount = sc.get("mount")
        if sc.get("solid") is False or sc.get("on") or (mount and mount != "floor"):
            continue  # rug, cushion, lamp on a table, picture on a wall: no place, no obstacle
        cx, cz = _centre(m)
        yaw = math.degrees(m["glbYaw"]) % 360 if m.get("glb") else float(sc.get("yaw") or 0) % 360
        s = sc["size"]
        w, d = s["w"], s["d"]
        kind = "sit" if _last_word(pid) in SIT else "stand"
        fx, fz = _front(yaw)
        off = d / 2 - 0.1 if kind == "sit" else d / 2 + 0.45
        room = m.get("room") or sc.get("room")
        level = (rooms.get(room) or {}).get("level")
        at = nav.snap(level, cx + fx * off, cz + fz * off)
        poses = _poses(_last_word(pid), s["h"])
        items.append({"poses": poses, "id": m["id"], "base": _last_word(pid), "room": room, "kind": kind, "yaw": yaw,
                      "center": [cx, cz], "at": at, "level": level,
                      "size": {"w": s["w"], "d": s["d"], "h": s["h"]},
                      "obstacle": _obstacle(cx, cz, w, d, yaw)})
    _name_places(items)
    places = []
    for it in items:
        if it["at"] is None:
            warnings.append(f"{it['id']}: no walkable nav cell within {SNAP_R} m, no place")
            continue
        pl = {"name": it["name"], "id": it["id"], "kind": it["kind"], "room": it["room"],
              "level": it["level"], "at": it["at"], "yaw": round(it["yaw"], 3),
              "look": it["center"] if it["kind"] != "sit" else None,
              "size": it["size"], "obstacle": it["obstacle"], "poses": it["poses"]}
        cx, cz = it["center"]
        if any(q in it["poses"] for q in ("lie", "sit", "stand_on")):
            pl["top"] = it["size"]["h"]
        if "stand_on" in it["poses"]:
            pl["stand_on"] = {"at": [cx, cz]}
        if "lie" in it["poses"]:
            w, d = it["size"]["w"], it["size"]["d"]
            # long side; the headboard is the back, opposite the front (yaw: 0 = +Z)
            ly = it["yaw"] if d >= w else (it["yaw"] + 90) % 360
            half = max(w, d) / 2
            fx, fz = _front(ly)
            if d < w:
                # long side runs across the front: head to the side whose front is `ly` back
                fx, fz = -fx, -fz
            pl["lie"] = {"at": [cx, cz], "yaw": round(ly, 3), "head": [cx - fx * half, cz - fz * half]}
        pl["slots"] = {q: (2 if (q == "sit" and "lie" in it["poses"]) else 1) for q in it["poses"] if q != "stand_at"}
        places.append(pl)
    for d in build.get("doors", []):
        hx, hz = d["hinge_at"]
        ex, ez = d["closed_end"]
        ox, oz = d["open_end"]
        wd = d["width"]
        c = [(hx + ex) / 2, (hz + ez) / 2]
        u = ((ox - hx) / wd, (oz - hz) / wd)
        room = d.get("swing") or d["rooms"][0]
        lv = (rooms.get(room) or {}).get("level")
        at = nav.snap(lv, c[0] + u[0] * (wd + 0.3), c[1] + u[1] * (wd + 0.3))
        if at is None:
            warnings.append(f"door {d['id']}: no walkable nav cell, no place")
            continue
        yaw = math.degrees(math.atan2(c[0] - at[0], c[1] - at[1])) % 360
        places.append({"name": f"{room} door", "id": d["id"], "kind": "door", "room": room, "level": lv,
                       "at": at, "yaw": round(yaw, 3), "look": c, "obstacle": None,
                       "poses": ["door"]})
    return {"places": places, "warnings": warnings}


def _voices(run_dir):
    cast_p = Path(run_dir) / "cast" / "cast.json"
    pool_p = Path(__file__).resolve().parents[1] / "dream" / "voices.json"
    if not (cast_p.is_file() and pool_p.is_file()):
        return {}
    pool = _load(pool_p)
    labels = {c.get("voice") for c in _load(cast_p).values() if isinstance(c, dict)}
    return {k: pool[k] for k in sorted(labels) if k in pool}


def _actors(run_dir, brief):
    """who gets an initial place: the cast names, else brief scene.who."""
    try:
        cast = _load(Path(run_dir) / "cast" / "cast.json")
    except (OSError, ValueError):
        cast = None
    if isinstance(cast, dict) and cast:
        return list(cast)
    who = (brief.get("scene") or {}).get("who") or []
    return [w for w in who if isinstance(w, str)]


def _book_voice(book_dir):
    """narrator_voice label from the book (spec: first-person books set it, default old_man)."""
    try:
        return json.loads(Path(book_dir, "book.json").read_text()).get("narrator_voice") or "old_man"
    except (OSError, ValueError):
        return None


def _scene_room(book_dir, scene_id):
    """The world room a book scene plays in: the scene's `room`, else its id; None if the book is unreadable."""
    try:
        book = json.loads(Path(book_dir, "book.json").read_text())
    except (OSError, ValueError):
        return None
    for ch in book.get("chapters") or []:
        for sc in ch.get("scenes") or []:
            if sc.get("id") == scene_id:
                return sc.get("room") or scene_id
    return scene_id


def pick_start(places, actors, room=None):
    """{actor: place name}: the closest group of places, so the cast starts together.

    `room` (the book scene's room) limits the choice to that room: on a one-place home the whole-world
    tightest group put the meadow scene in the bathroom. A room with no places -> the whole world.

    Round-robin over the list put Mama and Mirai 18 m apart on the meadow. Each place in turn is an
    anchor with its nearest neighbours; the group with the smallest spread wins. More actors than
    places -> names repeat (runtime fallback handles the overlap)."""
    if room is not None:
        here = [q for q in places if q.get("room") == room]
        if here:
            places = here
        else:
            print(f"stage: no places in room {room!r}, start picked over the whole world")
    if not places or not actors:
        return {}
    k = min(len(actors), len(places))

    def d(a, b):
        return ((a["at"][0] - b["at"][0]) ** 2 + (a["at"][1] - b["at"][1]) ** 2) ** 0.5
    best = None
    for a in places:
        group = sorted(places, key=lambda q: d(a, q))[:k]
        cost = sum(d(a, q) for q in group)
        if best is None or cost < best[0]:
            best = (cost, group)
    names = [q["name"] for q in best[1]]
    return {who: names[i % len(names)] for i, who in enumerate(actors)}


def write_stage(run_dir, out, brief=None, freestyle=False):
    """Writes out/places.json and out/stage.json; -> the stage.json dict.

    stage.json holds exactly the spec schema (dist, places, cast, mode, book,
    seed, objects, voices, narrator_voice, start). `freestyle` is accepted for
    backward compat with older callers but is NOT serialized: it is a play-time
    flag (`make.play --freestyle`), not part of the place."""
    run_dir, out = Path(run_dir), Path(out)
    brief = brief or {}
    res = build_places(run_dir / "world" / "run")
    (out / "places.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    names = [p["name"] for p in res["places"]]
    actors = _actors(run_dir, brief)
    room = None
    if brief.get("mode") == "book" and brief.get("book"):
        room = _scene_room(brief["book"]["dir"], brief["book"]["scene"])
    start = pick_start(res["places"], actors, room=room)
    sj = {"dist": "world/run/dist", "places": "stage/places.json", "cast": "cast/cast.json",
          "mode": brief.get("mode"), "book": None, "seed": None,
          "objects": [p["name"] for p in res["places"]], "voices": _voices(run_dir),
          "narrator_voice": None, "start": start}
    if brief.get("mode") == "book" and brief.get("book"):
        b = brief["book"]
        sj["book"] = {"dir": b["dir"], "scene": b["scene"], "score": "story/score.json"}
        sj["narrator_voice"] = _book_voice(b["dir"])
    elif (run_dir / "story" / "seed.txt").is_file():
        sj["seed"] = (run_dir / "story" / "seed.txt").read_text().strip()
    (out / "stage.json").write_text(json.dumps(sj, ensure_ascii=False, indent=2))
    return sj
