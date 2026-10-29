"""Attribute engine findings to the room that caused them.

Two mappers, one per scene a room is judged in. `blame_room` reads the scene
"skeleton + one room": the skeleton is green on its own, so anything that is
not structurally the skeleton's is that room's. `blame_global` reads the merged
floor, where every object names its room — except navigation findings, which
name nobody: those are bisected by re-checking the floor without each suspect.

The bisection is the only part that runs the engine, and it runs it once per
suspect room for the whole batch of findings, never once per finding.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from pipe2.engine import blocking
from pipe2.merge import merge, owner_of

SKELETON = "skeleton"

#: findings that name no object: only re-checking without a room finds the culprit
NAV_CODES = ("NAV_ROOM_CUT", "NAV_SPAWN_BLOCKED", "ROUTE_BLOCKED")

#: sections whose items carry the room that owns them
OWNED_SECTIONS = ("props", "decals", "lights", "cameras", "fixtures")

#: room fields a builder dresses, and so answers for
COSMETIC_ROOM_FIELDS = ("walls", "edges", "floor", "ceiling")

#: opening fields a builder dresses, and so answers for
COSMETIC_OPENING_FIELDS = ("leaf", "outside")

#: sections of the skeleton no builder can be blamed for
STRUCTURAL_SECTIONS = ("stairs", "levels", "walls")

#: keyed sections whose key starts with the room that declared it
KEYED_SECTIONS = ("materials", "assets")


def _parts(issue: dict) -> list[str]:
    return (issue.get("path") or "").split("/")


def _section(parts: list[str]) -> str:
    return parts[1] if len(parts) > 1 else ""


def _room_ids(scene: dict) -> set:
    return {r["id"] for r in scene.get("rooms") or [] if "id" in r}


def _by_key(scene: dict, parts: list[str]) -> str:
    """`/materials/<key>…`, `/assets/<key>…`: the room is the key's prefix."""
    key = parts[2] if len(parts) > 2 else ""
    room = key.split("_", 1)[0]
    return room if room in _room_ids(scene) else SKELETON


def _named_id(issue: dict):
    """The id a finding complains about, however the engine labelled it."""
    for key in ("v", "id", "value", "name"):
        named = issue.get(key)
        if isinstance(named, str):
            return named
    return None


def _structural_ids(scene: dict) -> set:
    """Ids the skeleton owns: rooms, openings, levels, stairs, walls, routes."""
    out = set()
    for section in ("rooms", "openings", "levels", "stairs", "walls", "routes"):
        for item in scene.get(section) or []:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                out.add(item["id"])
    return out


def _grouped(pairs) -> dict:
    out: dict[str, list] = {}
    for owner, issue in pairs:
        out.setdefault(owner, []).append(issue)
    return out


# --- skeleton + one room -------------------------------------------------


def blame_room(scene: dict, issues: list, room: str) -> dict:
    """Group findings of a single room's scene by owner (that room, or skeleton)."""
    return _grouped((_blame_in_room(scene, issue, room), issue) for issue in issues)


def _blame_in_room(scene: dict, issue: dict, room: str) -> str:
    parts = _parts(issue)
    section = _section(parts)
    if not section:
        return SKELETON
    code = issue.get("code")
    if code == "ROOMS_OVERLAP":
        return SKELETON
    if code == "ID_DUPLICATE" and _named_id(issue) in _structural_ids(scene):
        return SKELETON
    if section in STRUCTURAL_SECTIONS:
        return SKELETON
    if section == "openings":
        return room if _field(parts) in COSMETIC_OPENING_FIELDS else SKELETON
    if section in KEYED_SECTIONS:
        return _by_key(scene, parts)
    return room


def _field(parts: list[str]) -> str:
    """The field named right after an indexed section: `/openings/0/leaf/…`."""
    return parts[3] if len(parts) > 3 else ""


def _indexed(parts: list[str]) -> bool:
    return len(parts) > 2 and parts[2].isdigit()


# --- the merged floor ----------------------------------------------------


def blame_global(engine, work, skeleton: dict, partials: dict, plan: dict,
                 issues: list) -> dict:
    """Group findings of the whole floor by the room that caused each."""
    scene, _violations = merge(skeleton, partials, plan)
    rooms = _room_ids(scene)
    bisect = _Bisector(engine, work, skeleton, partials, plan)

    def owner(issue):
        found = _blame_on_floor(scene, plan, issue, bisect)
        return found if found in rooms else SKELETON

    return _grouped((owner(issue), issue) for issue in issues)


def _blame_on_floor(scene: dict, plan: dict, issue: dict, bisect) -> str:
    parts = _parts(issue)
    section = _section(parts)
    if issue.get("code") in NAV_CODES:
        return bisect.culprit(issue)
    if not section:
        return SKELETON
    if section in OWNED_SECTIONS and _indexed(parts):
        # PROP_HITS_PROP lands here too: the engine records the pair on the
        # later prop (engine/src/props/lint.ts:387), and that prop's owner
        # is the one asked to move it -- never both rooms.
        return owner_of(scene, {"path": "/%s/%s" % (section, parts[2])})
    if section == "rooms" and _field(parts) in COSMETIC_ROOM_FIELDS:
        return owner_of(scene, {"path": "/rooms/%s" % parts[2]})
    if section == "openings" and _field(parts) in COSMETIC_OPENING_FIELDS:
        return _opening_owner(scene, plan, parts)
    if section in KEYED_SECTIONS:
        return _by_key(scene, parts)
    return SKELETON


def _opening_owner(scene: dict, plan: dict, parts: list[str]) -> str:
    openings = scene.get("openings") or []
    if not _indexed(parts) or int(parts[2]) >= len(openings):
        return SKELETON
    oid = openings[int(parts[2])].get("id")
    return ((plan.get("openings") or {}).get(oid) or {}).get("owner") or SKELETON


class _Bisector:
    """Who owns a finding that names nobody: re-check the floor without a room.

    One `check_full` per suspect room, shared by every finding in the batch;
    the suspects are the rooms that actually wrote something.
    """

    def __init__(self, engine, work, skeleton: dict, partials: dict, plan: dict):
        self.engine = engine
        self.work = work
        self.skeleton = skeleton
        self.partials = partials
        self.plan = plan
        self._without = None

    def culprit(self, issue: dict) -> str:
        want = (issue.get("code"), issue.get("path"))
        for room, found in self._reports():
            if found is None:
                continue
            if want not in [(i.get("code"), i.get("path")) for i in found]:
                return room
        return SKELETON

    def _suspects(self) -> list[str]:
        return [r["id"] for r in self.skeleton.get("rooms") or []
                if self.partials.get(r.get("id"))]

    def _reports(self) -> list[tuple]:
        if self._without is None:
            suspects = self._suspects()
            if not suspects:
                self._without = []
            else:
                with ThreadPoolExecutor(max_workers=len(suspects)) as pool:
                    found = list(pool.map(self._check_without, suspects))
                self._without = list(zip(suspects, found))
        return self._without

    def _check_without(self, room: str):
        """Blocking findings of the floor without that room, or None if it dies."""
        rest = {k: v for k, v in self.partials.items() if k != room}
        scene, _violations = merge(self.skeleton, rest, self.plan)
        try:
            return blocking(self.engine.check_full(scene, self.work))
        except Exception:
            # the floor does not even check without that room: it proves nothing
            return None
