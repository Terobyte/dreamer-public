"""A wish said inside a built place -> a small building on the house's ground floor, built by the engine, attached live.

wish text -> Spark (what it is: sign, front picture, inside, objects) -> scene in the yard's own frame (an annex on a
15 cm podium against the main wall, a porch in front, a door between) -> Muse + SAM3D at once -> dreamer build -> dist.
The page sews the dist into the running world with __dreamer.attach (no reload).
"""
import json
import math
from pathlib import Path

from . import assets as A, spark
from .compile import BAY, TILE, P
from .progress import Progress

WISH = """Someone standing in a real post-Soviet courtyard in Kazakhstan says what should open on the ground floor of the
apartment block in front of them. Turn the wish into a small one-room building (a shop, cafe, pharmacy, workshop...).
It must look like it belongs to THIS yard: modest, a bit worn, local signs (Kazakh/Russian), not a glossy mall.
The courtyard: {yard}
Return ONE JSON object, no prose:
{{
 "label": "2-4 word name shown on the build plate, in the language of the wish",
 "sign": "exact sign text on the front (Kazakh or Russian, Cyrillic)",
 "board": "prompt for the sign board picture (a long horizontal board above the door): colours, lettering style, worn or lit",
 "window": "prompt for ONE shop window picture, straight-on: frame, glass, what is displayed behind it, a poster or price tag",
 "wall": "seamless texture prompt of the inside walls",
 "floor": "seamless texture prompt of the floor",
 "objects": [{{"id": "snake_case", "prompt": "one object on a plain white background, whole, three-quarter view: what it is, material, what is on it",
              "w": m, "d": m, "h": m, "place": "back|left|right|centre"}}]
}}
3 to 5 objects that make the place readable from the door (counter, shelves, fridge, a table...). Sizes in metres, realistic."""


def wish_spec(text, feat, log: Path):
    yard = feat.get("season", "") + "; " + feat["house"].get("wall_tile", "")
    obj, meta = spark.ask(WISH.format(yard=yard), [f"The wish: {text}"], effort="medium", log=log, max_tokens=12000,
                          validate=lambda o: (o["sign"], o["board"], o["window"], o["objects"][0]["prompt"]))
    return obj


def shop_scene(spec, site, wid):
    """site: {s0, s1} along the main wall; the annex stands out from the wall into the yard."""
    W = max(5.0, min(8.0, site["s1"] - site["s0"]))
    s0 = (site["s0"] + site["s1"]) / 2 - W / 2
    s1 = s0 + W
    n0, D, H, PD = 0.15, 5.0, 3.0, 1.8          # off the house wall, depth, height, porch depth
    pre = f"{wid}_"
    rooms = [
        {"id": pre + "shop", "level": "S", "height": H, "shape": [P(s0, n0), P(s1, n0), P(s1, n0 + D), P(s0, n0 + D)][::-1],
         "floor": "s_floor", "ceiling": "s_ceil", "walls": {"material": "s_wall"}, "facade": "s_side",
         "roof": {"material": "s_roof", "kind": "flat", "overhang": 0.25}},
        {"id": pre + "porch", "level": "S", "open": True,
         "shape": [P(s0, n0 + D), P(s1, n0 + D), P(s1, n0 + D + PD), P(s0, n0 + D + PD)][::-1], "floor": "s_porch"},
    ]
    sc = (s0 + s1) / 2
    openings = [{"id": pre + "door", "kind": "door", "at": P(sc, n0 + D), "width": 1.1, "height": 2.15, "sill": 0}]
    props = []
    slots = {"back": [], "left": [], "right": [], "centre": []}
    for o in spec["objects"][:5]:
        slots.get(o.get("place"), slots["centre"]).append(o)
    def put(o, s, n, yaw):
        props.append({"id": pre + o["id"], "asset": "so_" + o["id"], "room": pre + "shop", "at": P(s, n),
                      "size": {"w": float(o["w"]), "d": float(o["d"]), "h": float(o["h"])}, "yaw": yaw})
    for i, o in enumerate(slots["back"]):
        put(o, s0 + (i + 1) * W / (len(slots["back"]) + 1), n0 + 0.2 + float(o["d"]) / 2, 0)
    for side, sx, yaw in (("left", s0, 90), ("right", s1, -90)):
        for i, o in enumerate(slots[side]):
            put(o, sx + (1 if side == "left" else -1) * (0.15 + float(o["d"]) / 2), n0 + 1.2 + i * 1.6, yaw)
    for i, o in enumerate(slots["centre"]):
        put(o, sc + (i - (len(slots["centre"]) - 1) / 2) * 1.8, n0 + D * 0.45, 0)
    assets = {
        "st_board": {"kind": "decal", "aspect": "4:1", "prompt": BAY + spec["board"] + f". The board reads exactly: {spec['sign']}"},
        "st_window": {"kind": "decal", "aspect": "3:4", "prompt": BAY + spec["window"]},
        "st_wall": {"kind": "tile", "prompt": TILE + spec["wall"]},
        "st_floor": {"kind": "tile", "prompt": TILE + spec["floor"]},
    }
    for o in spec["objects"][:5]:
        assets["so_" + o["id"]] = {"kind": "object", "prompt": o["prompt"]}
    # the front: a sign board over the door, a shop window either side (a picture over the doorway would hide it)
    ww = round((W - 1.1) / 2 - 0.5, 2)
    decals = [{"asset": "st_board", "room": pre + "porch", "at": P(sc, n0 + D + 0.05), "y": 2.62,
               "size": {"w": round(W - 0.3, 2), "h": 0.7}}]
    for side in (-1, 1):
        decals.append({"asset": "st_window", "room": pre + "porch", "at": P(sc + side * (0.55 + 0.25 + ww / 2), n0 + D + 0.05),
                       "y": 1.25, "size": {"w": ww, "h": 1.7}})
    scene = {
        "version": 0, "name": spec["label"],
        "spawn": {"room": pre + "porch", "at": P(sc, n0 + D + 1.0), "yaw": 180},
        "style": {"ambient": 1.0, "exterior": "#c9ccd0"},
        "materials": {"s_floor": {"tile": "st_floor", "repeat_m": 1.2}, "s_wall": {"tile": "st_wall", "repeat_m": 1.5},
                      "s_ceil": {"color": "#e8e6df"}, "s_side": {"color": "#c9c3b6"}, "s_roof": {"color": "#6e6a64"},
                      "s_porch": {"color": "#8f8c86"}},
        "levels": [{"id": "S", "y": 0.15}], "rooms": rooms, "openings": openings, "props": props, "decals": decals,
        "assets": assets,
        "lights": [{"kind": "point", "pos": [round(sc, 2), 0.15 + H - 0.4, round(-(n0 + D / 2), 2)], "color": "#fff1d8", "intensity": 1.2}],
    }
    box = {"x0": min(s0, s1), "x1": max(s0, s1), "z0": -(n0 + D + PD), "z1": -n0, "y0": 0.15, "h": H,
           "room": {"x0": s0, "x1": s1, "z0": -(n0 + D), "z1": -n0}, "porch": {"x0": s0, "x1": s1, "z0": -(n0 + D + PD), "z1": -(n0 + D)},
           "door": {"x": round(sc, 3), "width": 1.1}}
    return scene, box


def build_wish(text, run: Path, wid: str, on_box=None):
    """Runs in a thread of the server. Writes run/parts/<wid>/progress.jsonl and dist/."""
    part = run / "parts" / wid
    part.mkdir(parents=True, exist_ok=True)
    prog = Progress(part / "progress.jsonl", ["wish", "shell_assets", "shell_build"], label=text[:40])
    try:
        feat = json.loads((run / "features.json").read_text())
        plan = json.loads((run / "plan.json").read_text())
        prog.start("wish", "reading the wish")
        spec = wish_spec(text, feat, part / "wish.txt")
        (part / "wish.json").write_text(json.dumps(spec, ensure_ascii=False, indent=1))
        prog.label = spec.get("label", prog.label)
        site = plan.get("shop_site") or {"s0": 30, "s1": 37}
        scene, box = shop_scene(spec, site, wid)
        (part / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))
        (part / "box.json").write_text(json.dumps({**box, "label": spec.get("label"), "sign": spec.get("sign")}, ensure_ascii=False))
        if on_box:
            on_box(box)
        prog.start("shell_assets", "front, walls, objects")
        res = A.fill_cache(scene, part, part / "cache", prog)
        (part / "assets.json").write_text(json.dumps(res, indent=1))
        prog.start("shell_build", "engine build")
        code = A.build_dist(part / "scene.json", part / "dist", part / "cache")
        if code == 0 and A.fit_props(part / "scene.json", part / "dist"):
            code = A.build_dist(part / "scene.json", part / "dist", part / "cache")
        if code != 0:
            raise RuntimeError(f"dreamer build failed ({code})")
        prog.finish(True, "ready")
    except Exception as e:
        prog.finish(False, str(e)[:300])
        raise
