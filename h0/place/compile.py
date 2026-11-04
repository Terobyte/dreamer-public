"""features (what the photos show) + plan (where it stands, yard frame) + OSM -> engine scene.json.

Code = space (rooms, levels, kerbs, fences in metres), Muse = surfaces (tiles, facade bays, door), SAM3D = objects
(cut out of the Street View frame named in the notes). Engine point = [s, -n]: s along the yard wall, n into the yard.
"""
import json
import math
import shutil
from pathlib import Path

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from .geo import SN

TILE = "seamless tileable photographic texture, natural muted colours, soft overcast daylight, no perspective, fills the frame: "
BAY = "straight-on orthographic facade picture, no perspective, fills the frame edge to edge, no sky, no ground: "


def P(s, n):
    return [round(float(s), 3), round(float(-n), 3)]


def _rect(s0, s1, n0, n1):
    return [P(s0, n0), P(s1, n0), P(s1, n1), P(s0, n1)]


def _poly_sn(sn: SN, poly):
    return [list(sn.sn(x, y)) for x, y in poly]


def _ccw(pts):
    a = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    return pts if a > 0 else pts[::-1]


def zone_strips(yard, zones):
    """Cut the yard box into non-overlapping rectangles: each cell takes the last zone covering it, cells merge along s."""
    s0, s1, n0, n1 = yard
    S = sorted({s0, s1, *[min(max(v, s0), s1) for z in zones for v in z["rect"][:2]]})
    N = sorted({n0, n1, *[min(max(v, n0), n1) for z in zones for v in z["rect"][2:]]})
    def floor_at(s, n):
        f = "lawn"
        for z in zones:
            a, b, c, d = z["rect"]
            if a <= s <= b and c <= n <= d:
                f = z["floor"]
        return f
    strips = []
    for j in range(len(N) - 1):
        if N[j + 1] - N[j] < 0.3:
            continue
        run = None
        for i in range(len(S) - 1):
            if S[i + 1] - S[i] < 0.3:
                continue
            f = floor_at((S[i] + S[i + 1]) / 2, (N[j] + N[j + 1]) / 2)
            if run and run[1] == f and abs(run[0][1] - S[i]) < 1e-6:
                run[0][1] = S[i + 1]
            else:
                if run:
                    strips.append(run)
                run = [[S[i], S[i + 1], N[j], N[j + 1]], f]
        if run:
            strips.append(run)
    return strips


def cameras_from_views(views, fr, sn: SN):
    """Street View panos (lat, lon, heading, fov) -> engine cameras at eye height, for the ref | result sheet."""
    cams = []
    for v in views:
        x, y = fr.xy(v["lat"], v["lon"])
        s, n = sn.sn(x, y)
        h = math.radians(v["h"])
        dx, dy = math.sin(h), math.cos(h)                 # heading: 0 = north, 90 = east
        ds, dn = dx * sn.d[0] + dy * sn.d[1], dx * sn.n[0] + dy * sn.n[1]
        cams.append({"id": v["id"], "pos": [round(s, 2), 1.6, round(-n, 2)],
                     "look": [round(s + 10 * ds, 2), 1.6, round(-(n + 10 * dn), 2)], "fov": v.get("fov", 75)})
    return cams


def compile_scene(feat, plan, layout, sn: SN, house_name, refs: Path, out_dir: Path, name="place", cameras=None, crowns=()):
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "refs").mkdir(exist_ok=True)
    H = feat["house"]
    floors, fh = int(H.get("floors", 5)), float(H.get("floor_h", 2.8))
    g = feat["ground"]
    assets = {
        "t_drive": {"kind": "tile", "prompt": TILE + g["drive"]},
        "t_lawn": {"kind": "tile", "prompt": TILE + g["lawn"]},
        "t_court": {"kind": "tile", "prompt": TILE + g["court"]},
        "t_kerb": {"kind": "tile", "prompt": TILE + g["kerb"]},
        "t_wall": {"kind": "tile", "prompt": TILE + H["wall_tile"]},
        "t_bay": {"kind": "tile", "prompt": BAY + H["bay"] + ". The picture tiles left-right and top-bottom: one storey, one window bay."},
        "t_bay0": {"kind": "tile", "prompt": BAY + H["bay_plain"] + f". Lower part painted: {H['plinth_tile']}. Tiles left-right."},
        "d_door": {"kind": "decal", "aspect": "2:3", "prompt": BAY + H["door"]},
        "s_sky": {"kind": "sky", "aspect": "2:1", "prompt": feat["sky_prompt"]},
    }
    mats = {
        "drive": {"tile": "t_drive", "repeat_m": 6}, "lawn": {"tile": "t_lawn", "repeat_m": 3},
        "court": {"tile": "t_court", "repeat_m": 5}, "kerb": {"tile": "t_kerb", "repeat_m": 1},
        "brick": {"tile": "t_wall", "repeat_m": 1.8}, "bay": {"tile": "t_bay", "repeat_m": fh},
        "bay0": {"tile": "t_bay0", "repeat_m": fh}, "roof": {"color": "#8d8f91"}, "inner": {"color": "#bdb8ae"},
        "concrete": {"color": "#a8a59e"}, "pipe": {"color": "#2e8a5c"}, "rod": {"color": "#26282a"},
    }
    for i, b in enumerate(feat.get("buildings", [])[:3]):
        assets[f"t_b{i}"] = {"kind": "tile", "prompt": BAY + b["facade"] + ". Tiles left-right and top-bottom."}
        mats[f"b{i}"] = {"tile": f"t_b{i}", "repeat_m": fh}

    rooms, props, walls, decals = [], [], [], []
    levels = [{"id": "L0", "y": 0}, {"id": "L1", "y": fh + 0.6}]
    yard = plan["yard"]
    yard_rooms = []
    # ---- buildings: the main house is two stacked rooms (ground floor + the rest) so it gets two facades ----
    others = 0
    for b in layout["buildings"]:
        poly = _poly_sn(sn, b["poly"])
        cs = sum(p[0] for p in poly) / len(poly); cn = sum(p[1] for p in poly) / len(poly)
        if not (yard[0] - 40 < cs < yard[1] + 40 and yard[2] - 40 < cn < yard[3] + 40):
            continue
        shape = _ccw([P(s, n) for s, n in poly])
        lv = b["levels"] or (floors if b["kind"] in ("apartments", "yes", "residential") else 1)
        bid = "house" if b["name"].endswith(house_name) else f"b_{b['id']}"
        if bid == "house":
            rooms.append({"id": "house_0", "level": "L0", "height": fh + 0.6, "shape": shape, "floor": "inner",
                          "ceiling": "inner", "walls": {"material": "inner"}, "facade": "bay0"})
            rooms.append({"id": "house_1", "level": "L1", "height": fh * (floors - 1), "shape": shape, "floor": "inner",
                          "ceiling": "inner", "walls": {"material": "inner"}, "facade": "bay",
                          "roof": {"material": "roof", "kind": "flat", "overhang": 0.2}})
        else:
            h = max(3.0, min(11.9, lv * fh))
            fac = f"b{others % max(1, len(feat.get('buildings', [])[:3]))}" if lv >= 3 and feat.get("buildings") else "brick"
            others += 1
            rooms.append({"id": bid, "level": "L0", "height": round(h, 2), "shape": shape, "floor": "inner",
                          "ceiling": "inner", "walls": {"material": "inner"}, "facade": fac,
                          "roof": {"material": "roof", "kind": "flat", "overhang": 0.2}})
    # ---- the yard: strips of drive / lawn / court, cut around every building footprint ----
    blocked = unary_union([Polygon(r["shape"]) for r in rooms]).buffer(0.01) if rooms else None
    k = 0
    for r, f in zone_strips(yard, plan.get("zones", [])):
        piece = Polygon(_rect(*r))
        if blocked is not None:
            piece = piece.difference(blocked)
        for part in getattr(piece, "geoms", [piece]):
            if part.is_empty or part.area < 1.0 or part.geom_type != "Polygon":
                continue
            part = part.simplify(0.05)
            pts = [[round(x, 3), round(z, 3)] for x, z in list(part.exterior.coords)[:-1]]
            yard_rooms.append({"id": f"yard_{k}", "level": "L0", "open": True, "shape": _ccw(pts), "floor": f})
            k += 1
    rooms = yard_rooms + rooms
    # ---- entrances on the main wall: door picture + canopy object ----
    can = feat.get("canopy")
    if can and can.get("frame"):
        _copy(refs, out_dir, can["frame"])
        assets["o_canopy"] = {"kind": "object", "prompt": can["what"], "ref": {"image": f"refs/{can['frame']}", "what": can["what"]}}
    for i, s in enumerate(plan.get("entrances", [])):
        decals.append({"asset": "d_door", "room": _room_at(rooms, s, 0.5), "at": P(s, 0.05), "y": 1.15, "size": {"w": 1.4, "h": 2.3}})
        if "o_canopy" in assets:
            ch = float(can.get("height_m", 1.0))
            props.append({"id": f"canopy_{i}", "asset": "o_canopy", "room": _room_at(rooms, s, 1.0), "at": P(s, 0.05),
                          "size": {"w": 2.6, "d": 1.5, "h": max(0.6, min(ch, 1.6))}, "mount": "wall", "y": 2.3, "solid": False})
    # ---- objects from the frames ----
    kinds = {o["id"]: o for o in feat.get("objects", [])}
    tree_kinds = [t for t in feat.get("trees", [])] or [{"id": "tree", "what": "a deciduous tree", "height_m": 9, "share": 1}]
    for t in tree_kinds:     # a tree is a cut-out picture on crossed planes (a SAM3D tree reads as a blob)
        assets["tb_" + t["id"]] = {"kind": "decal", "aspect": "3:4", "prompt": f"{t['what']}, {feat.get('season', '')}; the whole tree from the "
                                   "ground to the top of the crown, trunk visible, isolated, nothing else in the picture"}
    for k, o in kinds.items():
        if o.get("frame") and (refs / o["frame"]).exists():
            _copy(refs, out_dir, o["frame"])
            assets[f"o_{k}"] = {"kind": "object", "prompt": o["what"], "ref": {"image": f"refs/{o['frame']}", "what": o["what"]}}
        else:
            assets[f"o_{k}"] = {"kind": "object", "prompt": o["what"]}
    for i, p in enumerate(plan.get("props", [])):
        if p.get("id") not in kinds:
            continue
        h = float(p.get("h") or kinds[p["id"]].get("height_m", 1.0))
        w = float(p.get("w") or (h * 0.6 if p.get("tree") else max(0.5, h * 0.9)))
        d = float(p.get("d") or w)
        room = _room_at(rooms, p["s"], p["n"])
        at, w, d, h = _keep_inside(rooms, room, P(p["s"], p["n"]), w, d, h)
        if at is None:
            continue
        props.append({"id": f"{p['id']}_{i}", "asset": f"o_{p['id']}", "room": room,
                      "at": at, "size": {"w": round(w, 2), "d": round(d, 2), "h": round(h, 2)},
                      "yaw": float(p.get("yaw", 0)), "solid": not p.get("tree")})
    # ---- trees: the plan's, then the satellite's crowns that fall on the yard's lawns, kept off props and drives ----
    import random
    rnd = random.Random(7)
    lawns = [Polygon(r["shape"]) for r in rooms if r.get("open") and r["floor"] == "lawn"]
    taken = [(p["at"][0], p["at"][1], max(p["size"]["w"], p["size"]["d"]) / 2 + 1.2) for p in props]
    trees = [(t["s"], t["n"], float(t.get("h", 9)), t.get("id")) for t in plan.get("trees", [])]
    trees += [(cs, cn, 8 + 6 * f * rnd.random() + 2, None) for cs, cn, f in crowns]
    byid = {t["id"]: t for t in tree_kinds}
    shares = [(t["id"], float(t.get("share", 1))) for t in tree_kinds]
    placed = []
    for ts, tn, th, tid in trees:
        x, z = P(ts, tn)
        if not any(l.buffer(-0.8).contains(Point(x, z)) for l in lawns):
            continue
        if any(math.hypot(x - a, z - b) < r for a, b, r in taken) or any(math.hypot(x - a, z - b) < 2.6 for a, b in placed):
            continue
        if tid not in byid:
            u, acc, tid = rnd.random() * sum(w for _, w in shares), 0, shares[0][0]
            for k, w in shares:
                acc += w
                if u <= acc:
                    tid = k
                    break
        h = max(5.0, min(16.0, th))
        decals.append({"asset": "tb_" + tid, "room": _room_at(rooms, ts, tn), "at": [round(x, 3), round(z, 3)],
                       "rotation": round(rnd.random() * 60, 1), "upright": True, "size": {"w": round(h * 0.8, 2), "h": round(h, 2)}})
        placed.append((x, z))
    # ---- kerbs and fences: low walls ----
    # kerbs: flat white strips on the floor (a 18 cm wall would cut the nav into islands)
    for a in plan.get("kerbs", []):
        x0, z0 = P(a[0], a[1]); x1, z1 = P(a[2], a[3])
        L = math.hypot(x1 - x0, z1 - z0)
        if L < 0.5:
            continue
        decals.append({"asset": "d_kerb", "room": _room_at(rooms, (a[0] + a[2]) / 2, (a[1] + a[3]) / 2),
                       "at": [round((x0 + x1) / 2, 3), round((z0 + z1) / 2, 3)],
                       "rotation": round(-math.degrees(math.atan2(z1 - z0, x1 - x0)), 2), "size": {"w": round(L, 2), "h": 0.22}})
    if plan.get("kerbs"):
        assets["d_kerb"] = {"kind": "decal", "aspect": "4:1", "prompt": TILE + g["kerb"] + ", seen from above, a long narrow stone strip"}
    for f in plan.get("fences", []):
        if f.get("kind") != "concrete":   # a pipe or rod fence as a solid wall reads as a green slab; only concrete is a wall
            continue
        walls.append({"level": "L0", "from": P(*f["from"]), "to": P(*f["to"]), "h": float(f.get("h", 1.2)),
                      "thickness": 0.06, "material": {"concrete": "concrete", "rod": "rod"}.get(f.get("kind"), "pipe")})
    sp = plan.get("spawn") or {"s": (yard[0] + yard[1]) / 2, "n": 12, "look": [(yard[0] + yard[1]) / 2, 0]}
    look = sp.get("look", [sp["s"], 0])
    yaw = math.degrees(math.atan2(look[0] - sp["s"], look[1] - sp["n"]))
    scene = {
        "version": 0, "name": name,
        "spawn": {"room": _room_at(rooms, sp["s"], sp["n"]), "at": P(sp["s"], sp["n"]), "yaw": round(yaw, 1)},
        "style": {"ambient": 1.0, "exterior": "#c9ccd0"},
        "materials": mats, "levels": levels, "rooms": rooms, "walls": walls, "props": props, "decals": decals,
        "assets": assets,
        "outdoor": {"sky": "s_sky", "ground": {"material": "lawn", "radius": 160, "fade": 50}},
        "lights": [{"kind": "sun", "dir": [-0.4, -1.0, -0.3], "intensity": 1.2, "castShadow": False}],
    }
    if cameras:
        scene["cameras"] = cameras
    ov = out_dir.parent / "overrides.json"          # the critic's new prompts (look -> fix)
    if ov.exists():
        for k, prompt in json.loads(ov.read_text()).get("assets", {}).items():
            if k in scene["assets"]:
                pre = BAY if scene["assets"][k]["kind"] == "decal" or k.startswith(("t_bay", "t_b")) else TILE if scene["assets"][k]["kind"] == "tile" else ""
                scene["assets"][k]["prompt"] = pre + prompt
    (out_dir / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))
    return scene


def _copy(refs, out_dir, frame):
    dst = out_dir / "refs" / frame
    if not dst.exists():
        shutil.copy(refs / frame, dst)


def _room_at(rooms, s, n):
    """the open room under (s, n); off every yard -> the nearest one"""
    pt = Point(*P(s, n))
    best = None
    for r in rooms:
        if not r.get("open"):
            continue
        d = Polygon(r["shape"]).distance(pt)
        if best is None or d < best[0]:
            best = (d, r["id"])
    return best[1] if best else rooms[0]["id"]


def _keep_inside(rooms, room_id, at, w, d, h):
    """An open room's edge is a fence for props: move the prop in (its footprint circle inside the room), shrink if it must."""
    poly = Polygon(next(r["shape"] for r in rooms if r["id"] == room_id))
    for _ in range(4):
        r = math.hypot(w, d) / 2 + 0.1
        inner = poly.buffer(-r)
        if not inner.is_empty:
            pt = Point(*at)
            if not inner.contains(pt):
                from shapely.ops import nearest_points
                q = nearest_points(inner, pt)[0]
                at = [round(q.x, 3), round(q.y, 3)]
            return at, w, d, h
        w, d, h = w * 0.75, d * 0.75, h * 0.75
    return None, w, d, h
