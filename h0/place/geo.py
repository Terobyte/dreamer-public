"""Address -> metres: OSM buildings/roads from Overpass, satellite from Esri World Imagery tiles.

Frame: origin = the given lat/lon, x east, y north, metres (flat earth is fine at 200 m).
Every download is cached in the run folder, so a rebuild never touches the network again.
"""
import io
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

OVERPASS = ("https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter")
ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
UA = {"User-Agent": "dreamer-place/0.1"}
ROAD_W = {"primary": 10, "secondary": 9, "tertiary": 8, "residential": 7, "service": 4.5, "living_street": 5,
          "unclassified": 6, "footway": 2, "path": 1.5}


class Frame:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111320 * math.cos(math.radians(lat0))
        self.ky = 110540

    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def latlon(self, x, y):
        return (self.lat0 + y / self.ky, self.lon0 + x / self.kx)


def _get(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def overpass(lat, lon, radius, cache: Path):
    if cache.exists():
        return json.loads(cache.read_text())
    q = (f"[out:json][timeout:50];(way[\"building\"](around:{radius},{lat},{lon});"
         f"way[\"highway\"](around:{radius},{lat},{lon}););out geom tags;")
    err = None
    for url in OVERPASS:
        try:
            raw = _get(url, urllib.parse.urlencode({"data": q}).encode(), timeout=90)
            data = json.loads(raw)
            cache.write_text(json.dumps(data, ensure_ascii=False))
            return data
        except Exception as e:  # next mirror
            err = e
    raise RuntimeError(f"overpass failed: {err}")


def osm_layout(data, fr: Frame):
    """buildings [{name, levels, poly}], roads [{kind, width, pts}] in metres."""
    bld, roads = [], []
    for el in data.get("elements", []):
        t = el.get("tags", {})
        pts = [fr.xy(g["lat"], g["lon"]) for g in el.get("geometry", [])]
        if len(pts) < 2:
            continue
        if "building" in t:
            if pts[0] == pts[-1]:
                pts = pts[:-1]
            name = " ".join(x for x in (t.get("addr:street", ""), t.get("addr:housenumber", ""), t.get("name", "")) if x).strip()
            lv = t.get("building:levels")
            try:
                lv = int(float(lv)) if lv else None
            except ValueError:
                lv = None
            bld.append({"id": el["id"], "name": name or f"building {el['id']}", "levels": lv,
                        "kind": t.get("building"), "poly": [[round(x, 2), round(y, 2)] for x, y in pts]})
        elif "highway" in t:
            k = t["highway"]
            if k not in ROAD_W:
                continue
            roads.append({"kind": k, "width": ROAD_W[k], "name": t.get("name", ""),
                          "pts": [[round(x, 2), round(y, 2)] for x, y in pts]})
    return {"buildings": bld, "roads": roads}


def _tile(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def satellite(fr: Frame, radius, z, cache: Path):
    """Mosaic of Esri tiles covering the radius; returns (image, to_px) with to_px(x_m, y_m) -> (u, v)."""
    lat0, lon0 = fr.lat0, fr.lon0
    la1, lo1 = fr.latlon(-radius, -radius)
    la2, lo2 = fr.latlon(radius, radius)
    x1, y1 = _tile(la2, lo1, z)
    x2, y2 = _tile(la1, lo2, z)
    tx0, ty0, tx1, ty1 = int(x1), int(y1), int(x2), int(y2)
    meta = cache.with_suffix(".json")
    if not cache.exists():
        W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
        mosaic = Image.new("RGB", (W, H))
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                raw = _get(ESRI.format(z=z, x=tx, y=ty), timeout=30)
                mosaic.paste(Image.open(io.BytesIO(raw)).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
        mosaic.save(cache)
        meta.write_text(json.dumps({"z": z, "tx0": tx0, "ty0": ty0}))
    m = json.loads(meta.read_text())
    img = Image.open(cache).convert("RGB")

    def to_px(x, y):
        la, lo = fr.latlon(x, y)
        tx, ty = _tile(la, lo, m["z"])
        return (tx - m["tx0"]) * 256, (ty - m["ty0"]) * 256

    return img, to_px


def metres_per_px(lat, z):
    return 156543.03 * math.cos(math.radians(lat)) / 2 ** z


def edge_frame(poly, toward):
    """The yard wall of a house: the edge (>= 12 m) nearest to `toward` that faces it.
    Returns F, E (wall ends, metres) with n = left normal of F->E pointing to `toward`."""
    P = np.array(poly, float)
    best = None
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        L = np.linalg.norm(b - a)
        if L < 12:
            continue
        d = (b - a) / L
        nrm = np.array([-d[1], d[0]])
        t = np.array(toward) - a
        s, n = t @ d, t @ nrm
        if abs(n) < 1e-6:
            continue
        # which side: flip so n > 0
        if n < 0:
            a, b, d, nrm, s, n = b, a, -d, -nrm, L - s, -n
        off = 0 if 0 <= s <= L else min(abs(s), abs(s - L))
        score = n + 2 * off - 0.05 * L
        if best is None or score < best[0]:
            best = (score, a.tolist(), b.tolist())
    return best[1], best[2]


class SN:
    """The yard frame: s metres along the wall F->E, n metres out into the yard."""

    def __init__(self, F, E):
        self.F = np.array(F, float)
        E = np.array(E, float)
        self.L = float(np.linalg.norm(E - self.F))
        self.d = (E - self.F) / self.L
        self.n = np.array([-self.d[1], self.d[0]])

    def xy(self, s, n):
        p = self.F + s * self.d + n * self.n
        return [round(float(p[0]), 3), round(float(p[1]), 3)]

    def sn(self, x, y):
        t = np.array([x, y]) - self.F
        return float(t @ self.d), float(t @ self.n)
