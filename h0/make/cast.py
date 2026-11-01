"""Stage `cast`, path A: cast.json + GLB are placed by the host; the stage only checks them.
Fake: the fixture testdata/cast/. Live: the host's files in <run>/cast.src/."""
import json
import shutil
import struct
import time
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "testdata" / "cast"
VOICES = Path(__file__).resolve().parents[1] / "dream" / "voices.json"
H_MIN, H_MAX = 0.5, 2.5
_GLB_MAGIC = 0x46546C67  # b'glTF' as little-endian uint32
_COMP = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}  # componentType -> bytes
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def _idx(v, n):
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v < n


def _uint(v, lo=0):
    return isinstance(v, int) and not isinstance(v, bool) and v >= lo


_INDEX_CT = (5121, 5123, 5125)  # glTF indices: unsigned byte/short/int only


def _accessor_ok(doc, a, bin_len, position=False, indices=False):
    """Accessor `a` reads in-bounds data from the GLB's own BIN chunk."""
    accs, views, bufs = (doc.get(k) if isinstance(doc.get(k), list) else []
                         for k in ("accessors", "bufferViews", "buffers"))
    if not _idx(a, len(accs)) or not isinstance(accs[a], dict):
        return False
    acc = accs[a]
    ct, typ, count = acc.get("componentType"), acc.get("type"), acc.get("count")
    if (not _uint(ct) or ct not in _COMP or not isinstance(typ, str) or typ not in _NCOMP
            or not _uint(count, 1)):
        return False
    if position and (typ != "VEC3" or ct != 5126):
        return False
    if indices and (typ != "SCALAR" or ct not in _INDEX_CT):
        return False
    bv = acc.get("bufferView")
    if not _idx(bv, len(views)) or not isinstance(views[bv], dict):
        return False
    view = views[bv]
    b, voff, vlen = view.get("buffer"), view.get("byteOffset", 0), view.get("byteLength")
    if not (_idx(b, len(bufs)) and isinstance(bufs[b], dict) and _uint(voff) and _uint(vlen, 1)):
        return False
    buf = bufs[b]
    # self-contained character: only buffer 0 backed by the BIN chunk, no external uri
    if b != 0 or "uri" in buf or not _uint(buf.get("byteLength"), 1):
        return False
    if voff + vlen > buf["byteLength"] or buf["byteLength"] > bin_len:
        return False
    elem = _COMP[ct] * _NCOMP[typ]
    stride = view.get("byteStride", elem)
    aoff = acc.get("byteOffset", 0)
    if not (_uint(stride, elem) and _uint(aoff)):
        return False
    return aoff + stride * (count - 1) + elem <= vlen


def _gltf_doc_ok(doc, bin_len=0):
    """glTF 2.x document with a loadable character scene (Three.js shows a box otherwise).
    Every primitive needs a float VEC3 POSITION and all its attribute/index accessors
    must read in-bounds data from the GLB BIN chunk (`bin_len` bytes)."""
    if not isinstance(doc, dict):
        return False
    asset = doc.get("asset")
    if not isinstance(asset, dict):
        return False
    ver = asset.get("version")
    if not (isinstance(ver, str) and ver.split(".")[0] == "2"):
        return False
    for k in ("scenes", "nodes", "meshes"):
        v = doc.get(k)
        if not isinstance(v, list) or not v:
            return False
    scenes, nodes, meshes = doc["scenes"], doc["nodes"], doc["meshes"]
    scene = doc.get("scene", 0)
    if not isinstance(scene, int) or isinstance(scene, bool):
        return False
    if not 0 <= scene < len(scenes):
        return False
    for sc in scenes:
        refs = sc.get("nodes") if isinstance(sc, dict) else None
        if not isinstance(refs, list) or not refs:
            return False
        for r in refs:
            if not isinstance(r, int) or isinstance(r, bool) or not 0 <= r < len(nodes):
                return False
    for nd in nodes:
        if not isinstance(nd, dict):
            return False
        kids = nd.get("children", [])
        if not isinstance(kids, list):
            return False
        for r in kids:
            if not isinstance(r, int) or isinstance(r, bool) or not 0 <= r < len(nodes):
                return False
        m = nd.get("mesh")
        if m is not None and (not isinstance(m, int) or isinstance(m, bool)
                              or not 0 <= m < len(meshes)):
            return False
    for m in meshes:
        prims = m.get("primitives") if isinstance(m, dict) else None
        if not isinstance(prims, list) or not prims:
            return False
        for p in prims:
            attrs = p.get("attributes") if isinstance(p, dict) else None
            if not isinstance(attrs, dict) or "POSITION" not in attrs:
                return False
            for name, a in attrs.items():
                if not _accessor_ok(doc, a, bin_len, position=name == "POSITION"):
                    return False
            if "indices" in p and not _accessor_ok(doc, p["indices"], bin_len, indices=True):
                return False
    seen, stack = set(), list(scenes[scene].get("nodes") or [])
    reachable_mesh = False
    while stack:
        r = stack.pop()
        if r in seen:
            continue
        seen.add(r)
        nd = nodes[r]
        if nd.get("mesh") is not None:
            reachable_mesh = True
        stack.extend(nd.get("children") or [])
    if not reachable_mesh:
        return False
    return True


def _glb_ok(path):
    """Full GLB structure check: header + all chunks within bounds + valid glTF doc."""
    try:
        data = Path(path).read_bytes()
    except (OSError, ValueError):
        return False
    if len(data) < 12:
        return False
    magic, version, length = struct.unpack("<III", data[:12])
    if magic != _GLB_MAGIC or version != 2 or length != len(data):
        return False
    off, first, doc, bin_len = 12, True, None, 0
    while off < len(data):
        if off + 8 > len(data):
            return False
        clen, ctype = struct.unpack("<I4s", data[off:off + 8])
        if off + 8 + clen > len(data):
            return False
        payload = data[off + 8:off + 8 + clen]
        if first:
            if ctype != b"JSON":
                return False
            try:
                doc = json.loads(payload.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return False
        elif ctype == b"BIN\0" and not bin_len:
            bin_len = clen
        first = False
        off += 8 + clen
    try:
        return doc is not None and _gltf_doc_ok(doc, bin_len)
    except (TypeError, AttributeError, KeyError, IndexError, ValueError, OverflowError):
        return False  # malformed field types: a `<who>.glb` error, never a crash


def check_cast(cast_dir, voices=None):
    """-> list of 'who.field: problem' strings; [] when the cast is valid."""
    cast_dir = Path(cast_dir)
    p = cast_dir / "cast.json"
    try:
        cast = json.loads(p.read_text())
    except (OSError, ValueError) as e:
        return [f"cast.json: unreadable ({e})"]
    if not isinstance(cast, dict) or not cast:
        return ["cast.json: must be a non-empty object {who: {...}}"]
    if voices is None:
        voices = json.loads(VOICES.read_text())
    errs = []
    for who, c in cast.items():
        if not isinstance(c, dict):
            errs.append(f"{who}: must be an object")
            continue
        h = c.get("height_m")
        # a plain range check: NaN/inf fail it, huge JSON ints compare exactly (no float cast)
        if (isinstance(h, bool) or not isinstance(h, (int, float))
                or not H_MIN <= h <= H_MAX):
            errs.append(f"{who}.height_m: {h!r} not a number in [{H_MIN}, {H_MAX}]")
        v = c.get("voice")
        if not isinstance(v, str) or v not in voices:
            errs.append(f"{who}.voice: {c.get('voice')!r} not in voices.json")
        s = c.get("sex")
        if s not in ("male", "female"):
            errs.append(f"{who}.sex: {c.get('sex')!r} must be male|female")
        look = c.get("look")
        if not isinstance(look, str) or not look.strip():
            errs.append(f"{who}.look: {c.get('look')!r} must be a non-empty string")
        g = c.get("glb")
        ok = False
        if isinstance(g, str) and g and not Path(g).is_absolute():
            gp = cast_dir / g
            try:
                resolved, base = gp.resolve(), cast_dir.resolve()
                inside = resolved == base or base in resolved.parents
                ok = inside and gp.is_file() and _glb_ok(gp)
            except (OSError, ValueError):
                ok = False
        if not ok:
            errs.append(f"{who}.glb: {g!r} missing or not a GLB")
    return errs


def run_cast(ctx):
    src = FIXTURE if ctx.params.get("fake") else ctx.run_dir / "cast.src"
    if not (src / "cast.json").is_file():
        raise FileNotFoundError(f"cast path A: put cast.json and GLBs into {src}")
    errs = check_cast(src)
    if errs:
        raise ValueError("cast: " + "; ".join(errs))
    shutil.copytree(src, ctx.out, dirs_exist_ok=True)
    (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time()}))
    return 0.0
