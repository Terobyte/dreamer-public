"""A room with a picture must wear tiles on its floor and walls, not flat colours."""


def _ids(room: dict) -> list:
    """(field, material id) for the floor and every wall material of the room."""
    out = [("floor", room.get("floor"))]
    if room.get("open") is True and not room.get("walls"):
        return out
    walls = room.get("walls") or {}
    out.append(("walls.material", walls.get("material")))
    for n, band in enumerate(walls.get("bands") or []):
        if isinstance(band, dict):
            out.append(("walls.bands[%d].material" % n, band.get("material")))
    edges = room.get("edges") or {}
    if isinstance(edges, dict):
        for k, edge in edges.items():
            if isinstance(edge, dict):
                out.append(('edges["%s"].material' % k, edge.get("material")))
    return out


def plain_surfaces(scene: dict, room_id: str, has_ref: bool) -> list:
    if not has_ref:
        return []
    room = next((r for r in scene.get("rooms") or []
                 if isinstance(r, dict) and r.get("id") == room_id), None)
    if room is None:
        return []
    materials = scene.get("materials") or {}
    found = []
    for field, mid in _ids(room):
        if not isinstance(mid, str):
            continue
        mat = materials.get(mid)
        if isinstance(mat, dict) and "tile" in mat:
            continue
        found.append({"code": "PLAIN_SURFACE", "owner": room_id, "path": "/materials/" + mid,
                      "field": field,
                      "msg": "%s %s uses %s without a tile: room has a picture, draw a tile "
                             "from it and assign it" % (room_id, field, mid)})
    return found
