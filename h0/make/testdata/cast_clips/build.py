"""Builds the tiny skinned GLBs of the cast_clips fixture (stdlib only).
`build(outdir)` writes every file; the bytes are committed next to this script and
test_cast_clips.py checks that a fresh build matches them."""
import json
import struct
from pathlib import Path

_IDENT = (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)


def _pad(b, fill=b"\0"):
    return b + fill * (-len(b) % 4)


def _glb(doc, blob):
    js = _pad(json.dumps(doc, sort_keys=True).encode(), b" ")
    blob = _pad(blob)
    body = struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(blob), b"BIN\0") + blob
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def _model(joints=("hip", "spine", "head"), skin=True, anim=None, extra_nodes=()):
    """anim: None | {"name", "duration", "max": bool, "channels": [node names | None], "empty": bool}"""
    pos = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    jnt = bytes([0, 0, 0, 0] * 3)
    wgt = struct.pack("<12f", *([1, 0, 0, 0] * 3))
    ibm = struct.pack("<48f", *(_IDENT * 3))
    times = struct.pack("<2f", 0.0, float(anim["duration"])) if anim else b""
    vals = struct.pack("<8f", 0, 0, 0, 1, 0, 0, 0, 1) if anim else b""
    parts = [pos, jnt, wgt]
    if skin:
        parts.append(ibm)
    if anim:
        parts += [times, vals]
    views, blob = [], b""
    for p in parts:
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(p)})
        blob += p  # every part is a multiple of 4 bytes
    accs = [
        {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
         "min": [0, 0, 0], "max": [1, 1, 0]},
        {"bufferView": 1, "componentType": 5121, "count": 3, "type": "VEC4"},
        {"bufferView": 2, "componentType": 5126, "count": 3, "type": "VEC4"},
    ]
    attrs = {"POSITION": 0}
    if skin:
        attrs.update(JOINTS_0=1, WEIGHTS_0=2)
        accs.append({"bufferView": 3, "componentType": 5126, "count": 3, "type": "MAT4"})
    # nodes: 0 armature -> joints chain, then the skinned mesh node, then extras
    names = ["Armature", *joints, *extra_nodes]
    nodes = [{"name": n} for n in names]
    for i in range(len(names) - len(extra_nodes) - 1):
        nodes[i]["children"] = [i + 1]
    mesh_node = {"name": "Body", "mesh": 0}
    nodes.append(mesh_node)
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, len(nodes) - 1]}],
           "nodes": nodes, "meshes": [{"primitives": [{"attributes": attrs}]}],
           "accessors": accs, "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
    if skin:
        mesh_node["skin"] = 0
        doc["skins"] = [{"joints": list(range(1, 1 + len(joints))), "inverseBindMatrices": 3}]
    if anim and not anim.get("empty"):
        base = len(accs)
        tin = {"bufferView": 4 if skin else 3, "componentType": 5126, "count": 2, "type": "SCALAR",
               "min": [0.0], "max": [float(anim["duration"])]}
        if not anim.get("max", True):
            del tin["min"], tin["max"]
        tout = {"bufferView": 5 if skin else 4, "componentType": 5126, "count": 2, "type": "VEC4"}
        doc["accessors"] += [tin, tout]
        chans = []
        for tgt in anim["channels"]:
            t = {"path": "rotation"}
            if tgt is not None:
                t["node"] = names.index(tgt)
            else:
                t["node"] = len(nodes)  # points past the node list: no name to carry over
            chans.append({"sampler": 0, "target": t})
        doc["animations"] = [{"name": anim["name"], "channels": chans,
                              "samplers": [{"input": base, "output": base + 1,
                                            "interpolation": "LINEAR"}]}]
    elif anim:
        doc["animations"] = [{"name": anim["name"], "channels": [], "samplers": []}]
    return _glb(doc, blob)


def _anim(duration, channels=("hip",), name="rigAction", **kw):
    return dict(name=name, duration=duration, channels=list(channels), **kw)


def files():
    return {
        # the body carries its own rigAction: with `clips` set it must not count as a clip
        "body.glb": _model(anim=_anim(3.0)),
        "wake.glb": _model(anim=_anim(1.0)),
        "hug.glb": _model(anim=_anim(2.0, channels=("hip", "spine"))),
        "foreign.glb": _model(joints=("hip", "spine", "head", "tail"), anim=_anim(1.0)),
        "noanim.glb": _model(),
        "emptyanim.glb": _model(anim=_anim(1.0, empty=True)),
        "zero.glb": _model(anim=_anim(0.0)),
        "nomax.glb": _model(anim=_anim(1.0, max=False)),
        "unnamed.glb": _model(anim=_anim(1.0, channels=("hip", None))),
        "noskin_body.glb": _model(skin=False),
    }


def build(outdir):
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    for name, data in files().items():
        (out / name).write_bytes(data)


if __name__ == "__main__":
    build(Path(__file__).resolve().parent)
