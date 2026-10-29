"""Merge per-room partial scenes into the skeleton and attribute engine findings.

Pure functions: no network, no engine, no I/O. A builder owns exactly one room
and may only describe what lives in it; everything it oversteps becomes an
`OWN_*` violation and is dropped instead of silently landing in the scene.
"""

from pipe2.geom import in_room

PARTIAL_KEYS = ("props", "decals", "lights", "cameras", "assets", "materials")

#: sections of the merged scene that a builder contributes list items to
LIST_KEYS = ("props", "decals", "lights", "cameras")
DICT_KEYS = ("assets", "materials")


def _issue(owner, code, msg, path):
    return {"owner": owner, "code": code, "msg": msg, "path": path}


def _room_order(skeleton, partials):
    """Room ids in skeleton order, with unknown builders appended sorted."""
    known = [r["id"] for r in skeleton.get("rooms", [])]
    return known + sorted(k for k in partials if k not in known)


def _asset_declarations(order, partials):
    """key -> list of (room, spec), in room order."""
    decls = {}
    for room in order:
        for key, spec in (partials.get(room, {}).get("assets") or {}).items():
            decls.setdefault(key, []).append((room, spec))
    return decls


def merge(skeleton, partials, plan):
    """Return (scene, violations). Violations never raise and never merge."""
    import copy

    scene = copy.deepcopy(skeleton)
    for key in LIST_KEYS:
        scene[key] = list(scene.get(key) or [])
    for key in DICT_KEYS:
        scene[key] = dict(scene.get(key) or {})

    order = _room_order(skeleton, partials)
    rooms = {r["id"]: r for r in skeleton.get("rooms", [])}
    decls = _asset_declarations(order, partials)
    shared = {k for k, v in decls.items() if len(v) > 1}
    conflicting = {
        k
        for k in shared
        if len({spec.get("prompt") for _, spec in decls[k]}) > 1
    }

    issues = []
    for room_id in order:
        partial = partials.get(room_id) or {}
        prefix = room_id + "_"
        for key in partial:
            if key not in PARTIAL_KEYS:
                issues.append(_issue(
                    room_id, "OWN_KEY",
                    "a builder may only write %s" % ", ".join(PARTIAL_KEYS),
                    "/" + key,
                ))

        _merge_props(scene, issues, room_id, prefix, partial)
        _merge_decals(scene, issues, room_id, partial)
        _merge_lights(scene, issues, room_id, partial, rooms.get(room_id), plan)
        _merge_cameras(scene, issues, room_id, prefix, partial)
        _merge_assets(scene, issues, room_id, prefix, partial, shared, conflicting)
        _merge_materials(scene, issues, room_id, prefix, partial)

    return scene, issues


def _merge_props(scene, issues, room_id, prefix, partial):
    for i, prop in enumerate(partial.get("props") or []):
        path = "/props/%d" % i
        if prop.get("room") != room_id:
            issues.append(_issue(
                room_id, "OWN_ROOM",
                "prop belongs to room %r, not %r" % (prop.get("room"), room_id),
                path,
            ))
            continue
        if not str(prop.get("id", "")).startswith(prefix):
            issues.append(_issue(
                room_id, "OWN_PREFIX",
                "prop id %r must start with %r" % (prop.get("id"), prefix),
                path,
            ))
            continue
        scene["props"].append(prop)


def _merge_decals(scene, issues, room_id, partial):
    for i, decal in enumerate(partial.get("decals") or []):
        path = "/decals/%d" % i
        on_room = (decal.get("on") or {}).get("room")
        foreign = [r for r in (decal.get("room"), on_room)
                   if r is not None and r != room_id]
        if foreign:
            issues.append(_issue(
                room_id, "OWN_ROOM",
                "decal belongs to room %r, not %r" % (foreign[0], room_id),
                path,
            ))
            continue
        scene["decals"].append(decal)


def _merge_lights(scene, issues, room_id, partial, room, plan):
    budget = ((plan.get("rooms") or {}).get(room_id) or {}).get("max_points")
    kept = 0
    for i, light in enumerate(partial.get("lights") or []):
        path = "/lights/%d" % i
        if light.get("kind") == "hemi":
            issues.append(_issue(
                room_id, "OWN_HEMI", "hemi light belongs to the skeleton", path,
            ))
            continue
        pos = light.get("pos") or [0, 0, 0]
        if room is None or not in_room(room, float(pos[0]), float(pos[2])):
            issues.append(_issue(
                room_id, "OWN_LIGHT_OUTSIDE",
                "light at (%s, %s) is outside room %r" % (pos[0], pos[2], room_id),
                path,
            ))
            continue
        if budget is not None and kept >= budget:
            issues.append(_issue(
                room_id, "OWN_LIGHT_BUDGET",
                "room %r allows at most %d point lights" % (room_id, budget),
                path,
            ))
            continue
        kept += 1
        scene["lights"].append(light)


def _merge_cameras(scene, issues, room_id, prefix, partial):
    for i, cam in enumerate(partial.get("cameras") or []):
        if not str(cam.get("id", "")).startswith(prefix):
            issues.append(_issue(
                room_id, "OWN_PREFIX",
                "camera id %r must start with %r" % (cam.get("id"), prefix),
                "/cameras/%d" % i,
            ))
            continue
        scene["cameras"].append(cam)


def _merge_assets(scene, issues, room_id, prefix, partial, shared, conflicting):
    for key, spec in (partial.get("assets") or {}).items():
        path = "/assets/%s" % key
        if key in conflicting:
            issues.append(_issue(
                room_id, "OWN_ASSET_CONFLICT",
                "asset %r is declared with a different prompt by another room" % key,
                path,
            ))
            continue
        if key in shared:
            scene["assets"].setdefault(key, spec)
            continue
        if not key.startswith(prefix):
            issues.append(_issue(
                room_id, "OWN_PREFIX",
                "asset key %r must start with %r" % (key, prefix),
                path,
            ))
            continue
        scene["assets"][key] = spec


def _merge_materials(scene, issues, room_id, prefix, partial):
    for key, spec in (partial.get("materials") or {}).items():
        if not key.startswith(prefix):
            issues.append(_issue(
                room_id, "OWN_PREFIX",
                "material key %r must start with %r" % (key, prefix),
                "/materials/%s" % key,
            ))
            continue
        scene["materials"][key] = spec


def _at(scene, section, index):
    items = scene.get(section)
    if not isinstance(items, list) or not 0 <= index < len(items):
        return None
    return items[index]


def _room_ids(scene):
    return {r["id"] for r in scene.get("rooms", []) if "id" in r}


def owner_of(scene, issue):
    """Room id responsible for an engine finding, or "skeleton"."""
    parts = (issue.get("path") or "").split("/")
    if len(parts) < 3 or not parts[2].isdigit():
        return "skeleton"
    section, index = parts[1], int(parts[2])
    item = _at(scene, section, index)
    if item is None:
        return "skeleton"
    rooms = _room_ids(scene)

    if section == "props":
        owner = item.get("room")
    elif section == "decals":
        owner = item.get("room") or (item.get("on") or {}).get("room")
    elif section == "lights":
        # only point lights are a builder's; a hemi is always the skeleton's,
        # even when it happens to stand inside a room footprint
        pos = item.get("pos") or [0, 0, 0]
        owner = None if item.get("kind") == "hemi" else next(
            (r["id"] for r in scene.get("rooms", [])
             if in_room(r, float(pos[0]), float(pos[2]))),
            None,
        )
    elif section == "cameras":
        owner = str(item.get("id", "")).split("_", 1)[0]
    elif section == "rooms":
        owner = item.get("id")
    else:
        owner = None

    return owner if owner in rooms else "skeleton"


def _prop_owner(scene, ref):
    """Room of a prop named by id or by a `/props/i` path; None if not a prop."""
    if not isinstance(ref, str):
        return None
    if ref.startswith("/props/"):
        return owner_of(scene, {"path": ref})
    for prop in scene.get("props") or []:
        if prop.get("id") == ref:
            room = prop.get("room")
            return room if room in _room_ids(scene) else None
    return None


def split_owners(scene, issues):
    """Group findings by owner; a finding about two rooms goes to both."""
    out = {}
    for issue in issues:
        owners = []
        if issue.get("path"):
            owners.append(owner_of(scene, issue))
        for key in ("other", "a", "b"):
            owner = _prop_owner(scene, issue.get(key))
            if owner is not None:
                owners.append(owner)
        if not owners:
            owners = ["skeleton"]
        for owner in dict.fromkeys(owners):
            out.setdefault(owner, []).append(issue)
    return out
