"""Merge per-room partial scenes into the skeleton and attribute engine findings.

Pure functions: no network, no engine, no I/O. A builder owns exactly one room
and may only describe what lives in it; everything it oversteps becomes an
`OWN_*` violation and is dropped instead of silently landing in the scene.
"""

from pipe2.geom import in_room

import weakref

PARTIAL_KEYS = ("props", "decals", "lights", "cameras", "assets", "materials",
                "fixtures", "cosmetic")

#: sections of the merged scene that a builder contributes list items to
LIST_KEYS = ("props", "decals", "lights", "cameras")
DICT_KEYS = ("assets", "materials")

#: of a room's `walls`, only these are the builder's; `thickness` is geometry
COSMETIC_WALL_KEYS = ("material", "bands")

#: the one cosmetic field inside each dressable part of an opening
COSMETIC_OPENING_FIELDS = {"leaf": "decal", "outside": "backdrop"}


class _OwnedDict(dict):
    """A contributed item that remembers its room without leaking revisions.

    Plain dicts cannot be weak-referenced, so the contributors map below can
    only point back at these. Identity comparison keeps two builders' equal
    dicts distinct. Owner lookup falls back to position/prefix scans for
    scenes that bypassed merge.
    """

    __hash__ = object.__hash__


#: room that contributed each merged light/decal/camera, keyed weakly.
#: A boundary light sits inside several rooms and a decal may name no room,
# so position or fields alone cannot name the contributor; merge records it
#: while appending. Entries vanish once the merged scene is dropped.
_CONTRIBUTOR: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _record_contributor(item, room_id):
    if isinstance(item, _OwnedDict):
        _CONTRIBUTOR[item] = room_id


def _contributor(item):
    try:
        return _CONTRIBUTOR.get(item)
    except TypeError:
        return None


def _wrap(item):
    """Copy a contributed item so its contributor can be tracked."""
    if isinstance(item, _OwnedDict):
        return item
    if isinstance(item, dict):
        return _OwnedDict(item)
    return item


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
        _merge_fixtures(scene, issues, room_id, partial)
        _merge_cosmetic(scene, issues, room_id, partial, plan)

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
        decal = _wrap(decal)
        _record_contributor(decal, room_id)
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
        light = _wrap(light)
        _record_contributor(light, room_id)
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
        cam = _wrap(cam)
        _record_contributor(cam, room_id)
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


def _merge_fixtures(scene, issues, room_id, partial):
    if not partial.get("fixtures"):
        return
    # a scene without fixtures keeps the key absent: `[]` is not the same
    # document, and the merged scene is compared against the skeleton
    scene["fixtures"] = list(scene.get("fixtures") or [])
    for i, fix in enumerate(partial["fixtures"]):
        if (fix or {}).get("room") != room_id:
            issues.append(_issue(
                room_id, "OWN_ROOM",
                "fixture belongs to room %r, not %r" % ((fix or {}).get("room"), room_id),
                "/fixtures/%d" % i,
            ))
            continue
        scene["fixtures"].append(fix)


def _merge_cosmetic(scene, issues, room_id, partial, plan):
    """Lay a builder's surfaces over the skeleton; geometry stays untouched."""
    if "cosmetic" not in partial:
        return
    cosmetic = partial["cosmetic"]
    if not isinstance(cosmetic, dict):
        issues.append(_issue(
            room_id, "OWN_GEOMETRY", "cosmetic must be an object", "/cosmetic",
        ))
        return
    for key, value in cosmetic.items():
        if key == "room":
            if not isinstance(value, dict):
                issues.append(_issue(
                    room_id, "OWN_GEOMETRY", "cosmetic.room must be an object",
                    "/cosmetic/room",
                ))
                continue
            _cosmetic_room(scene, issues, room_id, value)
        elif key == "openings":
            if not isinstance(value, dict):
                issues.append(_issue(
                    room_id, "OWN_GEOMETRY", "cosmetic.openings must be an object",
                    "/cosmetic/openings",
                ))
                continue
            _cosmetic_openings(scene, issues, room_id, value, plan)
        else:
            issues.append(_issue(
                room_id, "OWN_GEOMETRY",
                "%r is not a cosmetic section" % key, "/cosmetic/%s" % key,
            ))


def _cosmetic_room(scene, issues, room_id, fields):
    room = next((r for r in scene.get("rooms") or [] if r.get("id") == room_id), None)
    if room is None:
        issues.append(_issue(
            room_id, "OWN_ROOM",
            "no room %r in the skeleton" % room_id, "/cosmetic/room",
        ))
        return
    for key, value in fields.items():
        path = "/cosmetic/room/%s" % key
        if key in ("floor", "ceiling"):
            room[key] = value
        elif key == "walls":
            if not isinstance(value, dict):
                issues.append(_issue(
                    room_id, "OWN_GEOMETRY", "walls must be an object", path,
                ))
                continue
            _cosmetic_walls(room, issues, room_id, value, path)
        elif key == "edges":
            if not isinstance(value, dict):
                issues.append(_issue(
                    room_id, "OWN_GEOMETRY", "edges must be an object", path,
                ))
                continue
            _cosmetic_edges(room, issues, room_id, value, path)
        else:
            issues.append(_issue(
                room_id, "OWN_GEOMETRY",
                "%s is geometry, not cosmetics" % key, path,
            ))


def _cosmetic_walls(room, issues, room_id, walls, path):
    for key, value in walls.items():
        if key not in COSMETIC_WALL_KEYS:
            issues.append(_issue(
                room_id, "OWN_GEOMETRY",
                "walls.%s is geometry, not cosmetics" % key, "%s/%s" % (path, key),
            ))
            continue
        room.setdefault("walls", {})[key] = value


def _cosmetic_edges(room, issues, room_id, edges, path):
    for edge, spec in edges.items():
        if not isinstance(spec, dict):
            issues.append(_issue(
                room_id, "OWN_GEOMETRY", "edges.%s must be an object" % edge,
                "%s/%s" % (path, edge),
            ))
            continue
        for key in spec:
            if key != "material":
                issues.append(_issue(
                    room_id, "OWN_GEOMETRY",
                    "edges.%s is geometry, not cosmetics" % key,
                    "%s/%s/%s" % (path, edge, key),
                ))
        if "material" in spec:
            room.setdefault("edges", {}).setdefault(edge, {})["material"] = spec["material"]


def _cosmetic_openings(scene, issues, room_id, wanted, plan):
    owners = plan.get("openings") or {}
    by_id = {o.get("id"): o for o in scene.get("openings") or []}
    for oid, spec in wanted.items():
        path = "/cosmetic/openings/%s" % oid
        if oid not in by_id or (owners.get(oid) or {}).get("owner") != room_id:
            issues.append(_issue(
                room_id, "OWN_OPENING",
                "opening %r is not room %r's to dress" % (oid, room_id), path,
            ))
            continue
        if not isinstance(spec, dict):
            issues.append(_issue(
                room_id, "OWN_GEOMETRY",
                "opening %r cosmetic must be an object" % oid, path,
            ))
            continue
        for key, value in spec.items():
            field = COSMETIC_OPENING_FIELDS.get(key)
            if field is None:
                issues.append(_issue(
                    room_id, "OWN_GEOMETRY",
                    "%s is geometry, not cosmetics" % key, "%s/%s" % (path, key),
                ))
                continue
            if not isinstance(value, dict):
                issues.append(_issue(
                    room_id, "OWN_GEOMETRY",
                    "%s must be an object" % key, "%s/%s" % (path, key),
                ))
                continue
            for other in value:
                if other != field:
                    issues.append(_issue(
                        room_id, "OWN_GEOMETRY",
                        "%s.%s is geometry, not cosmetics" % (key, other),
                        "%s/%s/%s" % (path, key, other),
                    ))
            if field in value:
                by_id[oid].setdefault(key, {})[field] = value[field]


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

    if section in ("props", "fixtures"):
        owner = item.get("room")
    elif section == "decals":
        contributor = _contributor(item)
        if contributor is not None and contributor in rooms:
            owner = contributor
        else:
            owner = item.get("room") or (item.get("on") or {}).get("room")
    elif section == "lights":
        # only point lights are a builder's; a hemi is always the skeleton's,
        # even when it happens to stand inside a room footprint.
        # A light on a shared boundary sits inside several rooms, so a
        # recorded contributor wins over the first room in skeleton order.
        contributor = _contributor(item)
        if contributor is not None and contributor in rooms:
            owner = contributor
        elif item.get("kind") == "hemi":
            owner = None
        else:
            pos = item.get("pos") or [0, 0, 0]
            owner = next(
                (r["id"] for r in scene.get("rooms", [])
                 if in_room(r, float(pos[0]), float(pos[2]))),
                None,
            )
    elif section == "cameras":
        contributor = _contributor(item)
        if contributor is not None and contributor in rooms:
            owner = contributor
        else:
            owner = _camera_owner(item, rooms)
    elif section == "rooms":
        owner = item.get("id")
    else:
        owner = None

    return owner if owner in rooms else "skeleton"


def _camera_owner(item, rooms):
    """Room from a camera id: the longest room id that prefixes it."""
    cid = str(item.get("id", ""))
    hit = ""
    for room in rooms:
        if cid == room or cid.startswith(room + "_"):
            if len(room) > len(hit):
                hit = room
    return hit or None


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
    """Group findings by owner; a finding about two rooms goes to both.

    Kept for compatibility: later phases blame through `pipe2.blame`. A
    `PROP_HITS_PROP` pair is one room's to fix -- the prop the engine wrote
    the finding on -- so it is never handed to both rooms.
    """
    out = {}
    for issue in issues:
        owners = []
        if issue.get("path"):
            owners.append(owner_of(scene, issue))
        if issue.get("code") == "PROP_HITS_PROP":
            for owner in dict.fromkeys(owners or ["skeleton"]):
                out.setdefault(owner, []).append(issue)
            continue
        for key in ("other", "a", "b"):
            owner = _prop_owner(scene, issue.get(key))
            if owner is not None:
                owners.append(owner)
        if not owners:
            owners = ["skeleton"]
        for owner in dict.fromkeys(owners):
            out.setdefault(owner, []).append(issue)
    return out
