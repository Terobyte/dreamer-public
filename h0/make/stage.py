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
        items.append({"id": m["id"], "base": _last_word(pid), "room": room, "kind": kind, "yaw": yaw,
                      "center": [cx, cz], "at": at, "level": level,
                      "size": {"w": s["w"], "d": s["d"], "h": s["h"]},
                      "obstacle": _obstacle(cx, cz, w, d, yaw)})
    _name_places(items)
    places = []
    for it in items:
        if it["at"] is None:
            warnings.append(f"{it['id']}: no walkable nav cell within {SNAP_R} m, no place")
            continue
        places.append({"name": it["name"], "id": it["id"], "kind": it["kind"], "room": it["room"],
                       "level": it["level"], "at": it["at"], "yaw": round(it["yaw"], 3),
                       "look": it["center"] if it["kind"] != "sit" else None,
                       "size": it["size"], "obstacle": it["obstacle"]})
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
                       "at": at, "yaw": round(yaw, 3), "look": c, "obstacle": None})
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
    start = {who: names[i % len(names)] for i, who in enumerate(actors)} if names else {}
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
