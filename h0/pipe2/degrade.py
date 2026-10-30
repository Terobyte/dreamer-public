"""Remove blocking content without spending more model calls, preserving a green base."""

import copy

from pipe2.blame import SKELETON, blame_global
from pipe2.engine import blocking, green
from pipe2.merge import merge

SECTIONS = ('props', 'decals', 'lights', 'cameras', 'fixtures')


def _depends(prop, ids):
    mount = prop.get('mount')
    around = prop.get('around')
    face = prop.get('face')
    return ((isinstance(mount, dict) and mount.get('top_of') in ids)
            or (isinstance(around, dict) and around.get('center') in ids)
            or (isinstance(face, str) and face in ids))


def _remove_object(parts, scene, issue, owner):
    path = (issue.get('path') or '').split('/')
    if len(path) < 3 or path[1] not in SECTIONS or not path[2].isdigit():
        return []
    section, index = path[1], int(path[2])
    objects = scene.get(section) or []
    if index >= len(objects):
        return []
    target = objects[index]
    own = (parts.get(owner) or {}).get(section) or []
    # Point lights need not have ids, so compare the merged object as well.
    selected = next((v for v in own if v == target or
                     (target.get('id') is not None and v.get('id') == target['id'])), None)
    if selected is None:
        return []
    own.remove(selected)
    removed = [{'room': owner, 'section': section, 'id': selected.get('id')}]
    ids = {selected['id']} if isinstance(selected.get('id'), str) else set()
    while ids:
        dependent = [p for p in (parts.get(owner) or {}).get('props', []) if _depends(p, ids)]
        if not dependent:
            break
        for prop in dependent:
            parts[owner]['props'].remove(prop)
            removed.append({'room': owner, 'section': 'props', 'id': prop.get('id')})
            if isinstance(prop.get('id'), str):
                ids.add(prop['id'])
    return removed


def degrade(engine, work, skeleton, partials, plan):
    parts = copy.deepcopy(partials)
    scene, _ = merge(skeleton, parts, plan)
    limit = sum(len(scene.get(s) or []) for s in SECTIONS) + len(skeleton.get('rooms', [])) + 2
    removed = []
    base_checked = False
    for _ in range(limit - 1):  # reserve one check for the base
        report = engine.check_full(scene, work)
        if green(report):
            return scene, removed
        issue = blocking(report)[0] if blocking(report) else {}
        grouped = blame_global(engine, work, skeleton, parts, plan, [issue])
        owner = next(iter(grouped), SKELETON)
        taken = _remove_object(parts, scene, issue, owner) if owner != SKELETON else []
        if taken:
            removed.extend(taken)
        elif owner in parts and parts[owner]:
            parts[owner] = {}
            removed.append({'room': owner, 'section': 'room', 'reason': issue.get('code')})
        else:
            if not base_checked:
                base_checked = True
                if not green(engine.check_full(skeleton, work)):
                    raise ValueError('accepted skeleton is no longer green')
            room = next((r['id'] for r in reversed(skeleton.get('rooms', [])) if parts.get(r['id'])), None)
            if room is None:
                break
            parts[room] = {}
            removed.append({'room': room, 'section': 'room', 'reason': issue.get('code')})
        scene, _ = merge(skeleton, parts, plan)
    removed.append({'section': 'floor', 'reason': 'fallback_to_skeleton'})
    return copy.deepcopy(skeleton), removed
